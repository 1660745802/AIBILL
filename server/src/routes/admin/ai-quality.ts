/**
 * AI 解析质量（统计 + 解析日志列表/详情）。
 * 列表/详情已剥离 `user_modified` / `modification_detail`（随 `parse-feedback` 下线，列仍在库里）。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getDb } from '../../db/index.js'
import { appLog } from '../../services/logger.js'
import { pageParam } from '../../lib/pagination.js'
import { filterStats } from '../../lib/parse-filter.js'

/**
 * 已下线字段：`user_modified` / `modification_detail` 随 `POST /api/ai/parse-feedback` 一起废弃。
 * 列保留（禁改已应用 migration），但**不再返回**给客户端；`final_items` 保留（落地回填仍在写它）。
 */
function stripRetiredParseLogFields(row: Record<string, unknown>): Record<string, unknown> {
  const { user_modified: _userModified, modification_detail: _modificationDetail, ...rest } = row
  return rest
}

export async function adminAiQualityRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/ai-parse-stats - AI 解析质量统计
  app.get('/api/admin/ai-parse-stats', async (request: FastifyRequest) => {
    const db = getDb()
    const { days } = request.query as { days?: string }
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 365)
    const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')



    // 总量 + 成功率 + 平均时长
    //
    // ⚠️ 「判非账」与「失败」在这里分开：`status='empty'` 且 `failure_code IS NULL`
    // = AI **明确判非账**（回了 `[]`），**不是故障**；只有 error/timeout 才是「AI 挂了」。
    // 旧口径把 empty 也算进「非成功」，「AI 挂了」的信号被噪声活埋（客户端专项明确要求）。
    //
    // 「不可用」还须排除**入参类失败**（input_empty/input_too_long）：那是客户端 bug，
    // 不是「AI 挂了」（与 lib/ai-failure.ts 的 AI_INPUT_FAILURE_CODES 对应）。
    const UNAVAILABLE = `status IN ('error', 'timeout') AND (failure_code IS NULL OR failure_code NOT IN ('input_empty', 'input_too_long'))`
    const overview = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
          COALESCE(SUM(CASE WHEN ${UNAVAILABLE} THEN 1 ELSE 0 END), 0) as unavailable_count,
          COALESCE(SUM(CASE WHEN status = 'empty' AND failure_code IS NULL THEN 1 ELSE 0 END), 0) as not_a_bill_count,
          COALESCE(SUM(CASE WHEN COALESCE(attempts, 1) > 1 THEN 1 ELSE 0 END), 0) as retried_count,
          COALESCE(SUM(CASE WHEN COALESCE(attempts, 1) > 1 AND status = 'success' THEN 1 ELSE 0 END), 0) as retry_rescued,
          ROUND(AVG(duration_ms)) as avg_duration_ms
         FROM ai_parse_logs
         WHERE created_at >= ?`,
      )
      .get(sinceDate) as {
      total: number
      success_count: number
      unavailable_count: number
      not_a_bill_count: number
      retried_count: number
      retry_rescued: number
      avg_duration_ms: number | null
    }

    const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0)
    const successRate = pct(overview.success_count, overview.total)
    const unavailableRate = pct(overview.unavailable_count, overview.total)
    const notABillRate = pct(overview.not_a_bill_count, overview.total)

    // 失败原因分布（022 的 failure_code）。这是「AI 挂了」的唯一可机械聚合的信号。
    const byFailureCode = db
      .prepare(
        `SELECT failure_code, COUNT(*) as count
           FROM ai_parse_logs
          WHERE created_at >= ? AND failure_code IS NOT NULL
          GROUP BY failure_code
          ORDER BY count DESC`,
      )
      .all(sinceDate) as Array<{ failure_code: string; count: number }>

    // 按渠道拆分（channel 是 019 的可空列；老 APK / 未上报的归 'unknown'）。
    const byChannelRows = db
      .prepare(
        `SELECT COALESCE(channel, 'unknown') as channel,
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
                COALESCE(SUM(CASE WHEN status = 'empty' AND failure_code IS NULL THEN 1 ELSE 0 END), 0) as not_a_bill_count,
                COALESCE(SUM(CASE WHEN ${UNAVAILABLE} THEN 1 ELSE 0 END), 0) as unavailable_count
           FROM ai_parse_logs
          WHERE created_at >= ?
          GROUP BY COALESCE(channel, 'unknown')
          ORDER BY total DESC`,
      )
      .all(sinceDate) as Array<{
      channel: string
      total: number
      success_count: number
      not_a_bill_count: number
      unavailable_count: number
    }>
    const byChannel = byChannelRows.map((c) => ({
      ...c,
      unavailable_rate: pct(c.unavailable_count, c.total),
    }))

    // 按状态分组
    const byStatus = db
      .prepare(
        `SELECT status, COUNT(*) as count
         FROM ai_parse_logs
         WHERE created_at >= ?
         GROUP BY status`,
      )
      .all(sinceDate) as Array<{ status: string; count: number }>

    // 最近失败记录
    const recentFailures = db
      .prepare(
        `SELECT id, user_id, raw_input, status, error_message, duration_ms, created_at,
                failure_code, attempts, channel
         FROM ai_parse_logs
         WHERE created_at >= ? AND status IN ('error', 'timeout')
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(sinceDate)

    return {
      code: 0,
      data: {
        range_days: rangeDays,
        overview: {
          total: overview.total,
          success_count: overview.success_count,
          success_rate: successRate,
          unavailable_count: overview.unavailable_count,
          unavailable_rate: unavailableRate,
          not_a_bill_count: overview.not_a_bill_count,
          not_a_bill_rate: notABillRate,
          retried_count: overview.retried_count,
          retry_rescued: overview.retry_rescued,
          avg_duration_ms: overview.avg_duration_ms || 0,
        },
        by_status: byStatus,
        /* 失败原因分布（按 failure_code）与按渠道拆分 —— 客户端把失败移出用户视野后，
           这两个是「AI 挂了」的唯一可见信号（见 docs/API.md 附录 C §9 / DATA §13.4）。 */
        by_failure_code: byFailureCode,
        by_channel: byChannel,
        /* recent_failures 里带**跨用户**的 raw_input（用户原话）——与「查看他人明细/原文」同口径，
           属于排障用途，按 ARCHITECTURE §5.3 必须写审计日志（复核：此前这条是审计缺口）。 */
        recent_failures: (() => {
          if (recentFailures.length > 0) {
            appLog('warn', 'admin', `查看解析失败明细（${recentFailures.length} 条，含跨用户原文）`, {
              admin_id: request.user!.userId,
              returned: recentFailures.length,
            })
          }
          return recentFailures
        })(),
        /* 服务端**预筛**统计（入站/出站分流）：`ai_parse_logs` 里看不到「被规则挡下、根本没调模型」
           的那些（它们记在 `ai_parse_filters`）——线上实测 53% 的通知在这里就被丢了，所以
           「空结果率」类指标必须与它一起看。⚠️ 这个函数此前**无任何消费者**（死代码），
           「服务端挡了多少」只能手工 SQL 查。 */
        prefilter: filterStats(db, null, rangeDays),
      },
      message: '',
    }
  })


  // GET /api/admin/ai-parse-logs - AI 解析日志列表（全部详细信息）
  app.get('/api/admin/ai-parse-logs', async (request: FastifyRequest) => {
    const db = getDb()
    const { page, page_size, status, user_id, days } = request.query as {
      page?: string
      page_size?: string
      status?: string
      user_id?: string
      days?: string
    }

    const pageNum = pageParam(page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(page_size, 20, 100)
    const offset = (pageNum - 1) * size

    // 构建过滤条件
    const conditions: string[] = []
    const params: any[] = []

    if (days) {
      const rangeDays = Math.min(Math.max(Number(days), 1), 365)
      const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')
      conditions.push('l.created_at >= ?')
      params.push(sinceDate)
    }

    if (status && ['success', 'empty', 'error', 'timeout'].includes(status)) {
      conditions.push('l.status = ?')
      params.push(status)
    }

    if (user_id) {
      conditions.push('l.user_id = ?')
      params.push(Number(user_id))
    }

    // 审计：解析日志含用户原始输入（raw_input），跨用户读取按 warn 记一条
    appLog('warn', 'admin', '管理员查看 AI 解析日志列表', {
      action: 'view_ai_parse_logs',
      admin_id: request.user!.userId,
      target_user_id: user_id ? Number(user_id) : null,
    })

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 总数
    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM ai_parse_logs l ${whereClause}`)
      .get(...params) as { total: number }

    // 分页查询，关联用户名
    const logs = db
      .prepare(
        `SELECT l.*, u.username
         FROM ai_parse_logs l
         LEFT JOIN users u ON l.user_id = u.id
         ${whereClause}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset)

    return {
      code: 0,
      data: {
        items: (logs as Array<Record<string, unknown>>).map(stripRetiredParseLogFields),
        pagination: {
          page: pageNum,
          page_size: size,
          total: countRow.total,
          total_pages: Math.ceil(countRow.total / size),
        },
      },
      message: '',
    }
  })


  // GET /api/admin/ai-parse-logs/:id - 单条解析日志详情
  app.get('/api/admin/ai-parse-logs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const log = db
      .prepare(
        `SELECT l.*, u.username
         FROM ai_parse_logs l
         LEFT JOIN users u ON l.user_id = u.id
         WHERE l.id = ?`,
      )
      .get(Number(id))

    if (!log) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在' }
    }

    // 审计：单条详情直接返回 raw_input 原文，跨用户读取按 warn 记一条
    appLog('warn', 'admin', `管理员查看 AI 解析原文: log_id=${id}`, {
      action: 'view_ai_parse_log_raw',
      admin_id: request.user!.userId,
      log_id: Number(id),
      target_user_id: (log as { user_id?: number }).user_id ?? null,
    })

    return { code: 0, data: stripRetiredParseLogFields(log as Record<string, unknown>), message: '' }
  })
}
