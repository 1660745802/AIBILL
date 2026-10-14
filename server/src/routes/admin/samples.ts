/**
 * 被拦样本 review（契约 docs/API.md 附录 C §11）——**两条通道**：
 * `capture-samples` = 客户端本地丢的采样；`filter-samples` = 客户端转发后被服务端预筛挡下的原文。
 * 两侧都只读 + 读原文写审计；标注只落人工意见，不写账、不回推。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../db/index.js'
import { appLog } from '../../services/logger.js'
import { pageParam } from '../../lib/pagination.js'

/** 采样人工标注（契约 docs/API.md 附录 C §11.6：admin 裁决为准，同 admin/unparsed 口径） */
const captureLabelSchema = z.object({
  label: z.enum(['is_bill', 'not_bill']),
})

/** 一个筛选条件：`key` 用于 facet 时「排除自己」，`sql`/`arg` 是参数化片段。 */
interface SampleFilter { key: string; sql: string; arg: unknown }

/**
 * 组装 WHERE。`excludeKey` 用于 **facet**：每个下拉框的选项要排除**它自己**那一维，
 * 否则一选中某项、选项就塔缩成只剩它自己（选完包名就看不到别的包了）。其余维**保留**
 * （选了包名后，「拦截点」选项仍按该包统计）。
 */
function sampleWhere(
  baseConds: string[],
  baseArgs: unknown[],
  filters: SampleFilter[],
  excludeKey?: string,
): { where: string; args: unknown[] } {
  const conds = [...baseConds]
  const args = [...baseArgs]
  for (const f of filters) {
    if (f.key === excludeKey) continue
    conds.push(f.sql)
    args.push(f.arg)
  }
  return { where: `WHERE ${conds.join(' AND ')}`, args }
}

export async function adminSampleRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/capture-samples —— 客户端拦截内容采集面（契约 §11.4 / §11.6）
  //
  // 客户端在本地丢掉的样本在这里被 review。**只读**：不写账、不重跑 AI、不改判定链。
  // `text` 原文**默认返回**（§11.5 的 P1 决策：先把「被拦了什么」拿到），含跨用户原文，
  // 所以按 ARCHITECTURE §5.3 写一条读审计（同 `GET /api/admin/unparsed?include_raw=1` 口径）。
  app.get('/api/admin/capture-samples', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const rangeDays = Math.min(Math.max(Number(q.days) || 7, 1), 90)
    const pageNum = pageParam(q.page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(q.page_size, 20, 100)

    if (q.channel !== undefined && !['nls', 'sms', 'a11y'].includes(q.channel)) {
      reply.code(400)
      return { code: 2000, data: null, message: `channel 非法：${q.channel}` }
    }

    const db = getDb()
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const baseConds = ['created_at >= ?']
    const baseArgs: unknown[] = [since]
    if (q.channel) { baseConds.push('channel = ?'); baseArgs.push(q.channel) }
    const filters: SampleFilter[] = []
    if (q.blocked_by) filters.push({ key: 'blocked_by', sql: 'blocked_by = ?', arg: q.blocked_by })
    if (q.package) filters.push({ key: 'package', sql: 'package = ?', arg: q.package })

    const full = sampleWhere(baseConds, baseArgs, filters)
    const facetBlockedBy = sampleWhere(baseConds, baseArgs, filters, 'blocked_by')
    const facetPackage = sampleWhere(baseConds, baseArgs, filters, 'package')

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM client_capture_samples ${full.where}`).get(...full.args) as { c: number }
    ).c
    const byBlockedBy = db
      .prepare(
        `SELECT blocked_by AS key, COUNT(*) AS count FROM client_capture_samples ${facetBlockedBy.where}
          GROUP BY blocked_by ORDER BY count DESC LIMIT 50`,
      )
      .all(...facetBlockedBy.args) as Array<{ key: string; count: number }>
    const byPackage = db
      .prepare(
        `SELECT package AS key, COUNT(*) AS count FROM client_capture_samples ${facetPackage.where}
          GROUP BY package ORDER BY count DESC LIMIT 50`,
      )
      .all(...facetPackage.args) as Array<{ key: string; count: number }>

    if (total > 0) {
      appLog('warn', 'admin', `查看客户端拦截样本（${total} 条，含原文）`, {
        action: 'view_capture_samples',
        admin_id: request.user!.userId,
        returned: Math.min(size, total),
      })
    }

    const items = db
      .prepare(
        `SELECT * FROM client_capture_samples ${full.where}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...full.args, size, (pageNum - 1) * size)

    return {
      code: 0,
      data: {
        items,
        summary: { total, by_blocked_by: byBlockedBy, by_package: byPackage },
        pagination: { page: pageNum, page_size: size, total, total_pages: Math.ceil(total / size) },
      },
      message: '',
    }
  })


  // POST /api/admin/capture-samples/:id/label —— 人工标注（契约 §11.6）
  //
  // 幂等：同一样本重复标注返回成功（不挡重复提交）。「是账」的后续整理（进
  // `rules.json.testcases(expect_txn=true)`）仍走发布流程，**不允许在线改判据**。
  app.post('/api/admin/capture-samples/:id/label', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: { label: 'is_bill' | 'not_bill' }
    try {
      body = captureLabelSchema.parse(request.body)
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
    const row = db.prepare('SELECT id FROM client_capture_samples WHERE id = ?').get(id)
    if (!row) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在' }
    }

    db.prepare('UPDATE client_capture_samples SET label = ? WHERE id = ?').run(body.label, id)
    return { code: 0, data: null, message: '' }
  })


  // GET /api/admin/filter-samples —— **forward 通道**（服务端预筛）拦下内容的 review
  //
  // 与 capture-samples 的分工：那边是客户端**本地丢**的样本，这边是客户端**转发**过来了、
  // 但被服务端预筛（`classifyNotification` / `verifyParsed`）挡下的原文。归表（§11.2）把 F 类
  // 5 条改成了 forward，但只看 `client_filter_stats` 的计数无法回答「拦对了吗」—— 本端点补这块。
  // **只读**：不写账、不重跑 AI、不改判定链。`raw_input` 是用户原文且跨用户，
  // 所以按 ARCHITECTURE §5.3 写读审计（同 `capture-samples` / `unparsed?include_raw=1`）。
  app.get('/api/admin/filter-samples', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const rangeDays = Math.min(Math.max(Number(q.days) || 7, 1), 90)
    const pageNum = pageParam(q.page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(q.page_size, 20, 100)

    if (q.channel !== undefined && !['nls', 'sms', 'a11y'].includes(q.channel)) {
      reply.code(400)
      return { code: 2000, data: null, message: `channel 非法：${q.channel}` }
    }
    if (q.stage !== undefined && !['inbound', 'outbound'].includes(q.stage)) {
      reply.code(400)
      return { code: 2000, data: null, message: `stage 非法：${q.stage}` }
    }

    const db = getDb()
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const baseConds = ['created_at >= ?']
    const baseArgs: unknown[] = [since]
    if (q.channel) { baseConds.push('channel = ?'); baseArgs.push(q.channel) }
    if (q.stage) { baseConds.push('stage = ?'); baseArgs.push(q.stage) }
    const filters: SampleFilter[] = []
    if (q.package) filters.push({ key: 'package', sql: 'source_package = ?', arg: q.package })
    /* `reasons` 是 JSON 数组：按「数组里**含**该项」过滤（json_each，与 `reasonsByCount` 同一口径，
       不用 LIKE 做子串匹配——那会把 `money` 命中 `money_only`）。COALESCE 只是防御 NULL。 */
    if (q.reason) {
      filters.push({
        key: 'reason',
        sql: 'EXISTS (SELECT 1 FROM json_each(COALESCE(ai_parse_filters.reasons, \'[]\')) WHERE json_each.value = ?)',
        arg: q.reason,
      })
    }

    const full = sampleWhere(baseConds, baseArgs, filters)
    const facetReason = sampleWhere(baseConds, baseArgs, filters, 'reason')
    const facetPackage = sampleWhere(baseConds, baseArgs, filters, 'package')

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM ai_parse_filters ${full.where}`).get(...full.args) as { c: number }
    ).c
    const byReason = db
      .prepare(
        `SELECT je.value AS key, COUNT(*) AS count
           FROM ai_parse_filters, json_each(COALESCE(ai_parse_filters.reasons, '[]')) je
          ${facetReason.where}
          GROUP BY je.value ORDER BY count DESC LIMIT 50`,
      )
      .all(...facetReason.args) as Array<{ key: string; count: number }>
    const byPackage = db
      .prepare(
        `SELECT source_package AS key, COUNT(*) AS count FROM ai_parse_filters ${facetPackage.where}
          GROUP BY source_package ORDER BY count DESC LIMIT 50`,
      )
      .all(...facetPackage.args) as Array<{ key: string | null; count: number }>

    if (total > 0) {
      appLog('warn', 'admin', `查看服务端预筛样本（${total} 条，含原文）`, {
        action: 'view_filter_samples',
        admin_id: request.user!.userId,
        returned: Math.min(size, total),
      })
    }

    const items = db
      .prepare(
        `SELECT id, created_at, channel, source_package, stage, tier, reasons, duration_ms,
                raw_input, length(raw_input) AS text_len, cleaned_input
           FROM ai_parse_filters ${full.where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...full.args, size, (pageNum - 1) * size)

    return {
      code: 0,
      data: {
        items,
        summary: { total, by_reason: byReason, by_package: byPackage },
        pagination: { page: pageNum, page_size: size, total, total_pages: Math.ceil(total / size) },
      },
      message: '',
    }
  })
}
