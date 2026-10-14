/**
 * 「不确定」集中裁决面（design: docs/ARCHITECTURE.md §3.9）。
 * 机器事实与人工意见分开存：裁决**绝不改 `ai_parse_logs`**、**绝不写 `transactions`**。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../db/index.js'
import { appLog } from '../../services/logger.js'
import { pageParam } from '../../lib/pagination.js'
import { AI_UNAVAILABLE_FAILURE_CODES } from '../../lib/ai-failure.js'

/** P2 人工裁决入参（docs/ARCHITECTURE.md §3.9）：`reason` 必填，可追责/可复盘 */
const triageSchema = z.object({
  action: z.enum(['mark_bill', 'mark_not_bill', 'mark_rule_missing']),
  reason: z.string().min(1, 'reason 不能为空').max(500, 'reason 过长'),
})

export async function adminUnparsedRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/unparsed —— 「不确定」集中裁决面 · P1 只读（design: docs/ARCHITECTURE.md §3.9）
  //
  // 客户端把「AI 失败 = 不确定」移出用户视野后，这些失败只剩服务端留痕。本端点把它们
  // 集中捞出来，让「这段窗口到底漏了哪些」可查。**只读、不写账、不重跑 AI、不碰判定链**。
  //
  // 默认**不给原文**：只给 `text_preview`（首 60 字）+ `raw_input_len`（够判「像不像账」）；
  // `include_raw=1` 才给全文，并写审计（与 GET /api/admin/ai-parse-logs 同口径）。
  app.get('/api/admin/unparsed', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const rangeDays = Math.min(Math.max(Number(q.days) || 7, 1), 90)
    const page = pageParam(q.page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(q.page_size, 20, 100)
    const includeRaw = q.include_raw === '1'

    if (q.channel !== undefined && !['nls', 'sms', 'a11y', 'manual'].includes(q.channel)) {
      reply.code(400)
      return { code: 2000, data: null, message: `channel 非法：${q.channel}` }
    }
    const channel = q.channel

    // 裁决动作过滤（P2 候选池导出：`?triage=mark_rule_missing` 即「待整理规则候选」）
    const TRIAGE_ACTIONS = ['mark_bill', 'mark_not_bill', 'mark_rule_missing'] as const
    if (q.triage !== undefined && !(TRIAGE_ACTIONS as readonly string[]).includes(q.triage)) {
      reply.code(400)
      return { code: 2000, data: null, message: `triage 非法：${q.triage}` }
    }
    const triageFilter = q.triage

    // failure_code 逗号多值；只接受 unavailable 集合（真源 lib/ai-failure.ts，不手抄）
    let codes: readonly string[] = AI_UNAVAILABLE_FAILURE_CODES
    if (q.failure_code) {
      const asked = q.failure_code.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = asked.find((c) => !AI_UNAVAILABLE_FAILURE_CODES.includes(c as never))
      if (asked.length === 0 || bad) {
        reply.code(400)
        return {
          code: 2000,
          data: null,
          message: `failure_code 非法或不属于 unavailable 集合：${bad ?? '(空)'}`,
        }
      }
      codes = asked
    }

    let targetUserId: number | null = null
    if (q.user_id !== undefined && q.user_id !== '') {
      const uid = Number(q.user_id)
      if (!Number.isInteger(uid) || uid <= 0) {
        reply.code(400)
        return { code: 2000, data: null, message: 'user_id 非法' }
      }
      targetUserId = uid
    }

    const db = getDb()
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const codePlaceholders = codes.map(() => '?').join(', ')
    const conds: string[] = [`failure_code IN (${codePlaceholders})`, 'created_at >= ?']
    const params: unknown[] = [...codes, since]
    if (channel) {
      conds.push('channel = ?')
      params.push(channel)
    }
    if (targetUserId !== null) {
      conds.push('user_id = ?')
      params.push(targetUserId)
    }
    if (triageFilter) {
      /* 「当前态」= 该 log 最新一行的 action（同 log 不同 action 允许、改判留历史）；
         用相关子查询而不是 `IN`，否则「先 mark_rule_missing 后 mark_bill」会被两个桶都算。 */
      conds.push(
        `(SELECT t.action FROM admin_unparsed_triage t WHERE t.parse_log_id = ai_parse_logs.id ORDER BY t.id DESC LIMIT 1) = ?`,
      )
      params.push(triageFilter)
    }
    const where = `WHERE ${conds.join(' AND ')}`

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM ai_parse_logs ${where}`).get(...params) as { c: number }).c

    const rows = db
      .prepare(
        `SELECT id, created_at, channel, source_package, failure_code, attempts, status, raw_input
           FROM ai_parse_logs ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, size, (page - 1) * size) as Array<{
      id: number
      created_at: string
      channel: string | null
      source_package: string | null
      failure_code: string
      attempts: number | null
      status: string
      raw_input: string | null
    }>

    const preview = (s: string | null): string => {
      const t = s ?? ''
      return t.length > 60 ? `${t.slice(0, 60)}…` : t
    }

    /* P2：把每行**最新的**裁决（当前态）带出来，供管理页显示与「候选池」查看。
       同 log 可能有多次/不同 action（历史不删），这里只取 id 最大的一行。 */
    const triageByLog = new Map<number, { action: string; reason: string; admin_id: number; created_at: string }>()
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      const tRows = db
        .prepare(
          `SELECT parse_log_id, action, reason, admin_id, created_at
             FROM admin_unparsed_triage
            WHERE parse_log_id IN (${ids.map(() => '?').join(', ')})
            ORDER BY id DESC`,
        )
        .all(...ids) as Array<{
        parse_log_id: number
        action: string
        reason: string
        admin_id: number
        created_at: string
      }>
      for (const t of tRows) {
        if (!triageByLog.has(t.parse_log_id)) {
          triageByLog.set(t.parse_log_id, {
            action: t.action,
            reason: t.reason,
            admin_id: t.admin_id,
            created_at: t.created_at,
          })
        }
      }
    }

    const items = rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      channel: r.channel,
      source_package: r.source_package,
      failure_code: r.failure_code,
      attempts: r.attempts,
      status: r.status,
      raw_input_len: (r.raw_input ?? '').length,
      text_preview: preview(r.raw_input),
      /* 默认脱敏：只给预览；`include_raw=1` 才给全文（并审计） */
      raw_input: includeRaw ? r.raw_input : null,
      /** 当前态裁决（P2）；null = 尚未裁决 */
      triage: triageByLog.get(r.id) ?? null,
    }))

    /* 跨用户读原文 → 审计（与 recent_failures / 解析日志列表同口径，ARCHITECTURE §5.3）。
       仓库目前**没有「自部署 / SaaS」模式标志**，所以统一按最保守的「默认关原文」实现；
       自部署默认开等策略待有模式标志后再谈（见 docs/ARCHITECTURE.md §3.9）。 */
    if (includeRaw && items.length > 0) {
      appLog('warn', 'admin', `查看未解析原文（${items.length} 条，含跨用户原文）`, {
        action: 'view_unparsed_raw',
        admin_id: request.user!.userId,
        returned: items.length,
        days: rangeDays,
        channel: channel ?? null,
        target_user_id: targetUserId,
      })
    }

    const byFailureCode = db
      .prepare(
        `SELECT failure_code, COUNT(*) AS count FROM ai_parse_logs ${where}
          GROUP BY failure_code ORDER BY count DESC`,
      )
      .all(...params) as Array<{ failure_code: string; count: number }>
    const byChannel = db
      .prepare(
        `SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*) AS count FROM ai_parse_logs ${where}
          GROUP BY COALESCE(channel, 'unknown') ORDER BY count DESC`,
      )
      .all(...params) as Array<{ channel: string; count: number }>

    return {
      code: 0,
      data: {
        window: { days: rangeDays },
        include_raw: includeRaw,
        items,
        pagination: { page, page_size: size, total, total_pages: Math.ceil(total / size) },
        summary: { total, by_failure_code: byFailureCode, by_channel: byChannel },
      },
      message: '',
    }
  })


  // POST /api/admin/unparsed/:id/triage —— P2 人工裁决（design: docs/ARCHITECTURE.md §3.9）
  //
  // ⚠️ 硬边界：**绝不改 `ai_parse_logs`**（机器事实与人工意见分开存）、**绝不写 `transactions`**
  // （不绕过「未确认不得声称已记」）。产品决策（2026-10，选 A）：`mark_bill` 也**不回推客户端**。
  // 幂等：同 (parse_log_id, admin_id, action) 重复提交返回成功（created=false）；同 log 不同 action 允许。
  app.post('/api/admin/unparsed/:id/triage', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: { action: 'mark_bill' | 'mark_not_bill' | 'mark_rule_missing'; reason: string }
    try {
      body = triageSchema.parse(request.body)
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }

    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400)
      return { code: 2000, data: null, message: 'id 非法' }
    }

    const db = getDb()
    const log = db.prepare('SELECT id, failure_code FROM ai_parse_logs WHERE id = ?').get(id) as
      | { id: number; failure_code: string | null }
      | undefined
    /* 只允许裁决「不确定」失败记录（与 P1 列表同一集合）；入参类 / 非失败 / 不存在一律 404。
       不区分「不存在」与「不是该集合」——避免泄漏「这个 id 存在但类型不同」。 */
    if (
      !log ||
      !log.failure_code ||
      !(AI_UNAVAILABLE_FAILURE_CODES as readonly string[]).includes(log.failure_code)
    ) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在或不是「不确定」失败记录' }
    }

    const adminId = request.user!.userId
    const inserted = db
      .prepare(
        `INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parse_log_id, admin_id, action) DO NOTHING`,
      )
      .run(id, body.action, body.reason, adminId)
    const saved = db
      .prepare(
        'SELECT id, created_at FROM admin_unparsed_triage WHERE parse_log_id = ? AND admin_id = ? AND action = ?',
      )
      .get(id, adminId, body.action) as { id: number; created_at: string }

    const created = inserted.changes > 0
    return {
      code: 0,
      data: {
        id: saved.id,
        parse_log_id: id,
        action: body.action,
        created,
        created_at: saved.created_at,
      },
      message: created ? '裁决已记录' : '裁决已存在（幂等）',
    }
  })
}
