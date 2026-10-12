/**
 * migration 021 / 客户端拦截计数上报 + admin 视图（契约 §4）
 *
 * 锁住的几条（都是「不说就会悄悄错」的）：
 *   1. **幂等**：同窗口重复上报是**覆盖**，不是累加（否则网络重试把计数翻倍）；
 *   2. **窗口归一**：`ISO8601` 与 `YYYY-MM-DD HH:MM:SS` 的同一时刻必须是同一个键
 *      （唯一键含窗口，不归一就会变成两行）；
 *   3. **命名空间**：只收 `precheck.*` / `client_only.*`，第三个前缀 400；
 *   4. **可比性**：`client_only.*` 恒不可比；`precheck.*` 只有命中当前清单才可比，
 *      对不上时在回执里回 `unknown_precheck_ids`（双向漂移信号）；
 *   5. admin 视图把客户端计数与服务端**入站** reason 并排给出，且**不**编「误杀率」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('客户端拦截计数上报（POST /api/ai/filter-report）', () => {
  let app: FastifyInstance
  let token: string
  let userId: number
  let adminToken: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'reportuser')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id
    adminToken = await loginAdmin(app)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const report = (payload: unknown, useToken = token) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/filter-report',
      headers: authHeaders(useToken),
      payload: payload as never,
    })

  const base = (over: Record<string, unknown> = {}) => ({
    window_start: '2026-10-12 00:00:00',
    window_end: '2026-10-12 23:59:59',
    client_version: '1.4.0',
    channel: 'nls',
    counts: [{ rule_id: 'precheck.coupon_facevalue', count: 3 }],
    totals: { notifications: 100, blocked: 53 },
    ...over,
  })

  const rows = (): Array<{ rule_id: string; hits: number; window_start: string }> =>
    getDb()
      .prepare('SELECT rule_id, hits, window_start FROM client_filter_stats WHERE user_id = ? ORDER BY rule_id')
      .all(userId) as never

  it('未认证 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ai/filter-report', payload: base() as never })
    expect(res.statusCode).toBe(401)
  })

  it('正常上报 → 200、落库、回执带 accepted', async () => {
    const res = await report(base())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.accepted).toBe(1)
    expect(body.data.unknown_precheck_ids).toEqual([])
    expect(rows()).toEqual([
      // '2026-10-12 00:00:00' 按**北京时间**解释 → 存 UTC 就是前一天 16:00
      { rule_id: 'precheck.coupon_facevalue', hits: 3, window_start: '2026-10-11 16:00:00' },
    ])
    const totals = getDb()
      .prepare('SELECT notifications, blocked FROM client_filter_totals WHERE user_id = ?')
      .get(userId) as { notifications: number; blocked: number }
    expect(totals).toEqual({ notifications: 100, blocked: 53 })
  })

  it('幂等：同窗口重复上报是**覆盖**不是累加', async () => {
    await report(base({ counts: [{ rule_id: 'precheck.marketing', count: 10 }] }))
    await report(base({ counts: [{ rule_id: 'precheck.marketing', count: 4 }] }))
    const row = getDb()
      .prepare("SELECT hits FROM client_filter_stats WHERE user_id = ? AND rule_id = 'precheck.marketing'")
      .get(userId) as { hits: number }
    expect(row.hits).toBe(4)
  })

  it('窗口归一：同一时刻的不同写法指向同一键（不产生第二行）', async () => {
    // 用独立 rule + 独立窗口，避免前面的用例把行数混进来
    const counts = [{ rule_id: 'precheck.zero_yuan', count: 1 }]
    const win = { window_start: '2026-10-20T00:00:00+08:00', window_end: '2026-10-20T23:59:59+08:00' }
    await report(base({ ...win, counts }))
    await report(base({ window_start: '2026-10-20 00:00:00', window_end: '2026-10-20 23:59:59', counts }))
    const cnt = getDb()
      .prepare(
        "SELECT COUNT(*) c FROM client_filter_stats WHERE user_id = ? AND rule_id = 'precheck.zero_yuan'",
      )
      .get(userId) as { c: number }
    expect(cnt.c).toBe(1)
  })

  it('窗口归一不依赖服务器时区：无时区串按北京时间解释', async () => {
    // 本机是 UTC+8 还是 UTC 都不能改变结果（曾经 Date.parse 按本机时区 → 差 8h）
    await report(
      base({
        window_start: '2026-09-01 00:00:00',
        window_end: '2026-09-01 23:59:59',
        counts: [{ rule_id: 'precheck.unrelated', count: 1 }],
      }),
    )
    const row = getDb()
      .prepare(
        "SELECT window_start FROM client_filter_stats WHERE user_id = ? AND rule_id = 'precheck.unrelated'",
      )
      .get(userId) as { window_start: string } | undefined
    expect(row?.window_start).toBe('2026-08-31 16:00:00')
  })

  it('命名空间：第三个前缀 → 400', async () => {
    const res = await report(base({ counts: [{ rule_id: 'server_reason.money', count: 1 }] }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).message).toMatch(/precheck\. 或 client_only\./)
  })

  it('client_only.* 收下且不回 unknown_precheck_ids', async () => {
    const res = await report(
      base({
        channel: 'a11y',
        counts: [
          { rule_id: 'client_only.SELF_NOTIFICATION', count: 2 },
          { rule_id: 'precheck.no_signal', count: 1 },
        ],
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).data.unknown_precheck_ids).toEqual([])
  })

  it('precheck.* 但不在当前清单 → 收下并在回执里回 unknown_precheck_ids', async () => {
    const res = await report(base({ counts: [{ rule_id: 'precheck.some_retired_rule', count: 1 }] }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).data.unknown_precheck_ids).toEqual(['precheck.some_retired_rule'])
  })

  it('blocked > notifications → 400', async () => {
    const res = await report(base({ totals: { notifications: 1, blocked: 2 } }))
    expect(res.statusCode).toBe(400)
  })

  it('窗口非法 / 倒置 / 跨度超 31 天 → 400', async () => {
    expect((await report(base({ window_start: 'not-a-time' }))).statusCode).toBe(400)
    expect((await report(base({ window_start: '2026-10-13 00:00:00' }))).statusCode).toBe(400)
    expect(
      (await report(base({ window_start: '2026-01-01 00:00:00', window_end: '2026-03-01 00:00:00' })))
        .statusCode,
    ).toBe(400)
  })

  it('counts 为空 / 缺 channel → 400', async () => {
    expect((await report(base({ counts: [] }))).statusCode).toBe(400)
    const noChannel = base()
    delete (noChannel as Record<string, unknown>).channel
    expect((await report(noChannel)).statusCode).toBe(400)
  })

  it('admin 视图：客户端计数与服务端入站 reason 并排，且标注可比性', async () => {
    // 造一条服务端入站拦截记录（ai_parse_filters）
    getDb()
      .prepare(
        `INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms)
         VALUES (?, '双11 5折', 'inbound', 0, '["marketing"]', 1)`,
      )
      .run(userId)
    // 出站记录不该出现在对照里
    getDb()
      .prepare(
        `INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms)
         VALUES (?, '某出站理由', 'outbound', 2, '["no_corroboration"]', 1)`,
      )
      .run(userId)

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/filter-stats?days=3650',
      headers: authHeaders(adminToken),
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload).data

    const marketing = data.client.by_rule.find((r: { rule_id: string }) => r.rule_id === 'precheck.marketing')
    expect(marketing.comparable).toBe(true)
    const clientOnly = data.client.by_rule.find((r: { rule_id: string }) => r.rule_id === 'client_only.SELF_NOTIFICATION')
    expect(clientOnly.namespace).toBe('client_only')
    expect(clientOnly.comparable).toBe(false)
    const retired = data.client.by_rule.find((r: { rule_id: string }) => r.rule_id === 'precheck.some_retired_rule')
    expect(retired.comparable).toBe(false)

    // 汇总口径
    expect(data.client.totals.notifications).toBeGreaterThan(0)
    expect(data.client.by_channel.some((c: { channel: string }) => c.channel === 'a11y')).toBe(true)

    // 服务端对照只含入站
    const reasons = data.server.by_reason.map((r: { reason: string }) => r.reason)
    expect(reasons).toContain('marketing')
    expect(reasons).not.toContain('no_corroboration')

    // 明说不编误杀率
    expect(data.note).toMatch(/误杀率不能由计数相减/)
  })

  it('admin 视图：普通用户 → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/filter-stats',
      headers: authHeaders(token),
    })
    expect(res.statusCode).toBe(403)
  })

  /* 客户端（Android）请求：把 `client_only.*` 的语义边界写在视图说明里，
     「免得下一个人误以为可比」。服务端**不维护 id→语义 映射**（映射会腐），
     只把规则与那个漂移告警点名。 */
  it('admin 视图说明：client_only.* 不可比、含诊断项、点名漂移告警', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/filter-stats?days=3650',
      headers: authHeaders(adminToken),
    })
    const note = JSON.parse(res.payload).data.note as string
    expect(note).toMatch(/client_only\.\*/)
    expect(note).toMatch(/不参与比较/)
    expect(note).toMatch(/client_only\.precheck_unknown_expr/)
    expect(note).toMatch(/漂移告警/)
    expect(note).toMatch(/误杀率不能由计数相减/)
  })

  it('诊断类条目（precheck_unknown_expr）可上报，且恒为不可比', async () => {
    const res = await report(
      base({
        channel: 'sms',
        counts: [{ rule_id: 'client_only.precheck_unknown_expr', count: 2 }],
      }),
    )
    expect(res.statusCode).toBe(200)

    const stats = await app.inject({
      method: 'GET',
      url: '/api/admin/filter-stats?days=3650',
      headers: authHeaders(adminToken),
    })
    const row = JSON.parse(stats.payload).data.client.by_rule.find(
      (r: { rule_id: string }) => r.rule_id === 'client_only.precheck_unknown_expr',
    )
    expect(row.namespace).toBe('client_only')
    expect(row.comparable).toBe(false)
  })
})
