/**
 * `GET /api/admin/filter-samples` —— **forward 通道**（服务端预筛）拦下内容的 review
 *
 * 归表（§11.2）把 F 类 5 条改成 forward 之后，这些通知由服务端预筛挡下、落进
 * `ai_parse_filters`（含原文）。只看计数回答不了「拦对了吗」，本端点补 review 侧。
 *
 * 锁住：
 *   1. 只读 + 403 非 admin；
 *   2. channel / stage 非法 → 400 `2000`；
 *   3. `items` 带原文与 `text_len`，`summary` 给 by_reason / by_package，`pagination` 可分页；
 *   4. **跨用户聚合口径**：默认全用户；`reason` 按「JSON 数组里含该项」精确匹配（不是子串）；
 *   5. 读原文写审计（`appLog` warn，`action=view_filter_samples`）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { recordFiltered } from '../../src/lib/parse-filter.js'

describe('admin/forward 通道样本（filter-samples）', () => {
  let app: FastifyInstance
  let adminToken: string
  let u1: number
  let u2: number

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token1 = await createUser(app, 'fs_user1')
    u1 = (JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token1) })).payload).data.user.id) as number
    const token2 = await createUser(app, 'fs_user2')
    u2 = (JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token2) })).payload).data.user.id) as number

    // 走**真实写入路径**（recordFiltered，即 /api/ai/parse 预筛用的那个）
    recordFiltered(getDb(), {
      userId: u1, rawInput: '午饭32', cleanedInput: '午饭32', stage: 'inbound', tier: 0,
      reasons: ['money_only', 'bare_amount'], durationMs: 1, channel: 'nls', sourcePackage: 'com.tencent.mm',
    })
    recordFiltered(getDb(), {
      userId: u1, rawInput: '双11 5折 全场开抢', cleanedInput: '双11 5折 全场开抢', stage: 'outbound', tier: 2,
      reasons: ['no_corroboration'], durationMs: 3, channel: 'a11y', sourcePackage: 'com.alipay',
    })
    recordFiltered(getDb(), {
      userId: u2, rawInput: '银行动账 ¥3200.00', stage: 'inbound', tier: 1,
      reasons: ['money_only'], durationMs: 2, channel: 'sms', sourcePackage: null,
    })
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const get = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/admin/filter-samples${qs}`, headers: authHeaders(adminToken) })

  it('普通用户无权访问（403）', async () => {
    const token = await createUser(app, 'fs_user3')
    const res = await app.inject({ method: 'GET', url: '/api/admin/filter-samples', headers: authHeaders(token) })
    expect(res.statusCode).toBe(403)
  })

  it('channel / stage 非法 → 400 {code:2000}', async () => {
    for (const qs of ['?channel=manual', '?stage=ai']) {
      const res = await get(qs)
      expect(res.statusCode, qs).toBe(400)
      expect(JSON.parse(res.payload).code, qs).toBe(2000)
    }
  })

  it('items 带原文/text_len/reasons，summary 与 pagination 齐备（跨用户聚合）', async () => {
    const data = JSON.parse((await get('?days=90')).payload).data
    expect(data.summary.total).toBe(3) // u1 两条 + u2 一条，跨用户全计
    // 同 count 的顺序 SQLite 不保证，按 key 对照而不是逐位断言
    const byReason = Object.fromEntries(
      (data.summary.by_reason as Array<{ key: string; count: number }>).map((r) => [r.key, r.count]),
    )
    expect(byReason).toMatchObject({ money_only: 2, bare_amount: 1, no_corroboration: 1 })

    const byPkg = data.summary.by_package as Array<{ key: string | null; count: number }>
    expect(byPkg.find((p) => p.key === 'com.tencent.mm')?.count).toBe(1)
    expect(byPkg.find((p) => p.key === 'com.alipay')?.count).toBe(1)
    expect(byPkg.find((p) => p.key === null)?.count).toBe(1) // source_package 为空的老行也进桶，不被吞
    expect(data.pagination).toMatchObject({ page: 1, total: 3 })

    // 不依赖返回顺序（同一秒写入时只靠 id 定序），按 source_package 找
    const items = data.items as Array<Record<string, any>>
    expect(items).toHaveLength(3)
    const alipay = items.find((i) => i.source_package === 'com.alipay')!
    expect(alipay).toMatchObject({
      channel: 'a11y',
      stage: 'outbound',
      tier: 2,
      duration_ms: 3,
      raw_input: '双11 5折 全场开抢',
    })
    expect(alipay.text_len).toBe('双11 5折 全场开抢'.length)
    expect(JSON.parse(alipay.reasons)).toEqual(['no_corroboration'])
    expect(alipay.cleaned_input).toBe('双11 5折 全场开抢')
  })

  it('reason 过滤按 JSON 数组里的**项**精确匹配（不做子串）', async () => {
    const money = JSON.parse((await get('?days=90&reason=money_only')).payload).data
    expect(money.summary.total).toBe(2)
    // 子串不该命中：没有叫 `money` 的 reason，但它会撞上 `money_only`
    expect(JSON.parse((await get('?days=90&reason=money')).payload).data.summary.total).toBe(0)
    expect(JSON.parse((await get('?days=90&reason=bare_amount')).payload).data.summary.total).toBe(1)
  })

  it('channel / stage / package 过滤', async () => {
    expect(JSON.parse((await get('?days=90&channel=nls')).payload).data.summary.total).toBe(1)
    expect(JSON.parse((await get('?days=90&stage=inbound')).payload).data.summary.total).toBe(2)
    expect(JSON.parse((await get('?days=90&stage=outbound')).payload).data.summary.total).toBe(1)
    const byPkg = JSON.parse((await get('?days=90&package=com.tencent.mm')).payload).data
    expect(byPkg.summary.total).toBe(1)
    // 列表列按契约：不含 user_id，但有原文与入口归因
    expect(Object.keys(byPkg.items[0] as Record<string, unknown>)).not.toContain('user_id')
    expect(byPkg.items[0]).toMatchObject({
      raw_input: '午饭32',
      cleaned_input: '午饭32',
      channel: 'nls',
      stage: 'inbound',
      tier: 0,
      source_package: 'com.tencent.mm',
    })
  })

  it('读原文写审计（appLog warn · action=view_filter_samples）', async () => {
    const q = (needle: string) =>
      (getDb().prepare(`SELECT COUNT(*) AS c FROM app_logs WHERE module='admin' AND message LIKE ?`).get(`%${needle}%`) as { c: number }).c
    const before = q('查看服务端预筛样本')
    await get('?days=90')
    expect(q('查看服务端预筛样本')).toBe(before + 1)

    const row = getDb()
      .prepare(`SELECT data FROM app_logs WHERE module='admin' AND message LIKE ? ORDER BY id DESC LIMIT 1`)
      .get('%查看服务端预筛样本%') as { data: string | null }
    expect(JSON.parse(row.data ?? '{}')).toMatchObject({ action: 'view_filter_samples', admin_id: 1 })
  })
})
