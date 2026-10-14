/**
 * admin 拦截样本面（契约 docs/API.md 附录 C §11.4 / §11.6）
 *
 * `GET /api/admin/capture-samples`（只读 + 读原文审计）、
 * `POST /api/admin/capture-samples/:id/label`（人工标注，幂等）。
 * 另锁一条真实事故点：带 `user_id` 外键的新表必须进 `USER_SCOPED_TABLES`，否则删用户会失败。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('admin/拦截样本', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'captureadmin')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id

    const ins = getDb().prepare(
      `INSERT INTO client_capture_samples
         (user_id, client_version, channel, package, kind, stage, blocked_by, tier, text, text_len, content_hash)
       VALUES (?, '1.7.0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    ins.run(userId, 'a11y', 'com.tencent.mm', 'a11y_page', 'capture', 'capture.a11y.not_whitelisted', 0, '支付成功 ¥32', 8, 'h1')
    ins.run(userId, 'nls', 'com.eg.android.AlipayGphone', 'notification', 'prefilter', 'client_only.marketing', 2, '双11 5折', 7, 'h2')
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const list = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/admin/capture-samples${qs}`, headers: authHeaders(adminToken) })
  const label = (id: number | string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/capture-samples/${id}/label`,
      headers: authHeaders(adminToken),
      payload: body as never,
    })

  it('普通用户无权访问（403）', async () => {
    const token = await createUser(app, 'captureadmin2')
    const res = await app.inject({ method: 'GET', url: '/api/admin/capture-samples', headers: authHeaders(token) })
    expect(res.statusCode).toBe(403)
  })

  it('列表：items + summary(total / by_blocked_by / by_package) + pagination，text 原文返回', async () => {
    const data = JSON.parse((await list('?package=com.tencent.mm')).payload).data
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({
      channel: 'a11y',
      package: 'com.tencent.mm',
      blocked_by: 'capture.a11y.not_whitelisted',
      text: '支付成功 ¥32', // P1：默认返回原文
      label: null,
    })
    expect(data.summary.total).toBe(1)
    expect(data.summary.by_blocked_by).toEqual([{ key: 'capture.a11y.not_whitelisted', count: 1 }])
    /* facet：`by_package` **排除 `package` 自己那一维**（否则一选中某包、下拉选项就塔缩成只剩它）。
       所以按 `package=com.tencent.mm` 过滤后，`by_package` 仍列出窗口内**全部**包。 */
    expect(data.summary.by_package).toEqual(
      expect.arrayContaining([
        { key: 'com.tencent.mm', count: 1 },
        { key: 'com.eg.android.AlipayGphone', count: 1 },
      ]),
    )
    expect(data.pagination).toMatchObject({ page: 1, page_size: 20, total: 1, total_pages: 1 })
  })

  it('facet 不塔缩：按 blocked_by 过滤时 by_blocked_by 仍列出全部规则（排除自己）', async () => {
    const data = JSON.parse((await list('?blocked_by=capture.a11y.not_whitelisted')).payload).data
    expect(data.summary.total).toBe(1)
    expect(data.summary.by_blocked_by).toEqual(
      expect.arrayContaining([
        { key: 'capture.a11y.not_whitelisted', count: 1 },
        { key: 'client_only.marketing', count: 1 },
      ]),
    )
  })

  it('按 channel / blocked_by 过滤', async () => {
    const byChannel = JSON.parse((await list('?channel=nls')).payload).data
    expect(byChannel.items.every((r: { channel: string }) => r.channel === 'nls')).toBe(true)
    expect(byChannel.items.length).toBeGreaterThanOrEqual(1)

    const byRule = JSON.parse((await list('?blocked_by=client_only.marketing')).payload).data
    expect(byRule.summary.total).toBe(1)
    expect(byRule.items[0].package).toBe('com.eg.android.AlipayGphone')
  })

  it('channel 非法 → 400 {code:2000}', async () => {
    const res = await list('?channel=manual')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2000)
  })

  it('label：合法值写入；改判幂等成功；非法值 400；不存在 404', async () => {
    const id = (
      getDb().prepare('SELECT id FROM client_capture_samples WHERE content_hash = ?').get('h1') as { id: number }
    ).id
    const labelOf = (): string | null =>
      (getDb().prepare('SELECT label FROM client_capture_samples WHERE id = ?').get(id) as { label: string | null }).label

    const ok = await label(id, { label: 'is_bill' })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.payload).code).toBe(0)
    expect(labelOf()).toBe('is_bill')

    // 幂等：重复/改判都返回成功
    expect((await label(id, { label: 'is_bill' })).statusCode).toBe(200)
    expect(labelOf()).toBe('is_bill')
    expect((await label(id, { label: 'not_bill' })).statusCode).toBe(200)
    expect(labelOf()).toBe('not_bill')

    const bad = await label(id, { label: 'maybe' })
    expect(bad.statusCode).toBe(400)
    expect(JSON.parse(bad.payload).code).toBe(2000)

    const missing = await label(999999, { label: 'is_bill' })
    expect(missing.statusCode).toBe(404)
    expect(JSON.parse(missing.payload).code).toBe(3002)
  })

  it('删用户不因 client_capture_samples 外键失败（USER_SCOPED_TABLES 含它）', async () => {
    const token = await createUser(app, 'capture_del')
    const me = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).payload,
    ).data.user
    getDb()
      .prepare(
        `INSERT INTO client_capture_samples (user_id, channel, package, kind, stage, blocked_by, content_hash)
         VALUES (?, 'nls', 'com.x', 'notification', 'capture', 'b', 'hx')`,
      )
      .run(me.id)

    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${me.id}`, headers: authHeaders(adminToken) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).code).toBe(0)
    expect(getDb().prepare('SELECT id FROM users WHERE id = ?').get(me.id)).toBeUndefined()
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM client_capture_samples WHERE user_id = ?').get(me.id) as { c: number }).c,
    ).toBe(0)
  })
})
