/**
 * `GET /api/admin/filter-stats` 的**客户端漏斗**块（契约 §4）
 *
 * 客户端把捕获层漏斗（`client_only.capture_received_* / capture_dropped_*`）与
 * AI 失败丢弃（`client_only.unparsed_ai_failed`）一起上报；服务端**不新增接口**，
 * 只按前缀机械归类后回一个 received→dropped→unparsed 的层次（供「漏账在哪一层丢的」定位）。
 *
 * 锁住的：
 *   1. 只收 `capture_received_* / capture_dropped_* / unparsed_ai_failed` 三类，
 *      其它 `client_only.*`（如 marketing）**不得**混进漏斗（否则数字没有意义）；
 *   2. 按渠道拆分（上报本身按渠道）；
 *   3. `dropped_reasons` 降序，能看出哪条早退判据在干活。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'

describe('admin/filter-stats 的客户端漏斗块', () => {
  let app: FastifyInstance
  let token: string
  let adminToken: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'funneluser')
    adminToken = await loginAdmin(app)

    const report = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/ai/filter-report', headers: authHeaders(token), payload: payload as never })

    // nls：收到 10 / 早退 3 / AI 失败丢弃 3；混入一条非漏斗项（marketing）做反例
    await report({
      window_start: '2026-10-12 00:00:00',
      window_end: '2026-10-12 23:59:59',
      client_version: '1.6.1',
      channel: 'nls',
      counts: [
        { rule_id: 'client_only.capture_received_nls', count: 10 },
        { rule_id: 'client_only.capture_dropped_nls_no_package', count: 2 },
        { rule_id: 'client_only.capture_dropped_nls_no_extras', count: 1 },
        { rule_id: 'client_only.unparsed_ai_failed', count: 3 },
        { rule_id: 'client_only.marketing', count: 99 },
      ],
      totals: { notifications: 10, blocked: 3 },
    })
    // a11y：收到 8 / 早退 4 / AI 失败丢弃 1
    await report({
      window_start: '2026-10-12 00:00:00',
      window_end: '2026-10-12 23:59:59',
      client_version: '1.6.1',
      channel: 'a11y',
      counts: [
        { rule_id: 'client_only.capture_received_a11y', count: 8 },
        { rule_id: 'client_only.capture_dropped_a11y_debounce', count: 4 },
        { rule_id: 'client_only.unparsed_ai_failed', count: 1 },
      ],
      totals: { notifications: 8, blocked: 4 },
    })
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const fetchStats = () =>
    app.inject({ method: 'GET', url: '/api/admin/filter-stats?days=30', headers: authHeaders(adminToken) })

  it('received / dropped / unparsed 三类汇总，非漏斗项被排除', async () => {
    const funnel = JSON.parse((await fetchStats()).payload).data.client.funnel
    expect(funnel.received).toBe(18) // 10 + 8
    expect(funnel.dropped).toBe(7) // 3 + 4
    expect(funnel.unparsed_ai_failed).toBe(4) // 3 + 1
    // marketing 的 99 **不得**混进任一桶
    expect(funnel.dropped).not.toBe(106)
  })

  it('按渠道拆分', async () => {
    const funnel = JSON.parse((await fetchStats()).payload).data.client.funnel
    const byChannel = Object.fromEntries((funnel.by_channel as any[]).map((c) => [c.channel, c]))
    expect(byChannel.nls).toEqual({ channel: 'nls', received: 10, dropped: 3, unparsed_ai_failed: 3 })
    expect(byChannel.a11y).toEqual({ channel: 'a11y', received: 8, dropped: 4, unparsed_ai_failed: 1 })
  })

  it('dropped_reasons 降序（看出哪条早退在干活）', async () => {
    const funnel = JSON.parse((await fetchStats()).payload).data.client.funnel
    expect(funnel.dropped_reasons.map((r: any) => r.rule_id)).toEqual([
      'client_only.capture_dropped_a11y_debounce',
      'client_only.capture_dropped_nls_no_package',
      'client_only.capture_dropped_nls_no_extras',
    ])
    expect(funnel.dropped_reasons[0].hits).toBe(4)
  })

  it('by_rule 仍照旧返回（漏斗是**增量**块，不改既有形状）', async () => {
    const data = JSON.parse((await fetchStats()).payload).data
    expect(Array.isArray(data.client.by_rule)).toBe(true)
    expect(data.client.by_rule.some((r: any) => r.rule_id === 'client_only.marketing')).toBe(true)
    expect(data.client.totals.notifications).toBe(18)
  })
})
