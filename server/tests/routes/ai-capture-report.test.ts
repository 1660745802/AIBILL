/**
 * 客户端拦截内容采集（`POST /api/ai/capture-report`，契约 docs/API.md 附录 C §11.3）
 *
 * 锁住四件事：
 *   1. **幂等**：`UNIQUE(user_id, content_hash, blocked_by)` —— 同一样本重发只累 `duplicates`；
 *   2. **计数**：`accepted`/`duplicates` 按条计（含批内重复）；
 *   3. **校验**：字段 / 上限 / 窗口非法一律 400 `2000`；
 *   4. **硬边界**：只落 `client_capture_samples`，**绝不写 `transactions`**（也绝不调 AI）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('客户端拦截内容采集（POST /api/ai/capture-report）', () => {
  let app: FastifyInstance
  let token: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'captureuser')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (payload: unknown, useToken = token) =>
    app.inject({
      method: 'POST',
      url: '/api/ai/capture-report',
      headers: authHeaders(useToken),
      payload: payload as never,
    })

  const sample = (over: Record<string, unknown> = {}) => ({
    channel: 'a11y',
    package: 'com.tencent.mm',
    kind: 'a11y_page',
    stage: 'capture',
    blocked_by: 'capture.a11y.not_whitelisted',
    tier: 0,
    received_at: '2026-10-14T12:31:00+08:00',
    text: '支付成功 ¥32.00',
    text_len: 14,
    content_hash: 'sha256:aaa',
    redacted: false,
    ...over,
  })
  const base = (over: Record<string, unknown> = {}) => ({
    client_version: '1.7.0',
    window_start: '2026-10-14 00:00:00',
    window_end: '2026-10-14 23:59:59',
    samples: [sample()],
    ...over,
  })

  const countRows = (uid = userId) =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM client_capture_samples WHERE user_id = ?').get(uid) as { c: number }).c
  const countTxns = () =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(userId) as { c: number }).c

  it('未认证 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ai/capture-report', payload: base() as never })
    expect(res.statusCode).toBe(401)
  })

  it('首批 → accepted=1 / duplicates=0，落库字段完整，且不写 transactions', async () => {
    const before = countRows()
    const txBefore = countTxns()
    const res = await post(base())
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({
      code: 0,
      data: { accepted: 1, duplicates: 0 },
      message: '',
    })
    expect(countRows()).toBe(before + 1)

    const row = getDb()
      .prepare('SELECT * FROM client_capture_samples WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as Record<string, unknown>
    expect(row).toMatchObject({
      client_version: '1.7.0',
      channel: 'a11y',
      package: 'com.tencent.mm',
      kind: 'a11y_page',
      stage: 'capture',
      blocked_by: 'capture.a11y.not_whitelisted',
      tier: 0,
      received_at: '2026-10-14T12:31:00+08:00',
      text: '支付成功 ¥32.00',
      text_len: 14,
      content_hash: 'sha256:aaa',
      label: null,
    })
    expect(countTxns()).toBe(txBefore)
  })

  it('同 (content_hash, blocked_by) 重发 → duplicates=1，不新增行', async () => {
    const before = countRows()
    const res = await post(base())
    expect(JSON.parse(res.payload).data).toEqual({ accepted: 0, duplicates: 1 })
    expect(countRows()).toBe(before)
  })

  it('同 content_hash 不同 blocked_by → 两条（一笔可能被多条规则解释）', async () => {
    const before = countRows()
    const res = await post(base({ samples: [sample({ blocked_by: 'client_only.marketing' })] }))
    expect(JSON.parse(res.payload).data).toEqual({ accepted: 1, duplicates: 0 })
    expect(countRows()).toBe(before + 1)
  })

  it('一批多条 → accepted/duplicates 按条计（含批内重复）', async () => {
    const before = countRows()
    const res = await post(
      base({
        samples: [
          sample({ content_hash: 'sha256:b1' }),
          sample({ content_hash: 'sha256:b2' }),
          sample({ content_hash: 'sha256:b1' }), // 批内重复
        ],
      }),
    )
    expect(JSON.parse(res.payload).data).toEqual({ accepted: 2, duplicates: 1 })
    expect(countRows()).toBe(before + 2)
  })

  it('text_len 缺省 → 落库按 text.length 补', async () => {
    const { text_len: _drop, ...noLen } = sample({ content_hash: 'sha256:c1', text: 'abcde' })
    const res = await post(base({ samples: [noLen] }))
    expect(res.statusCode).toBe(200)
    const row = getDb()
      .prepare('SELECT text_len FROM client_capture_samples WHERE content_hash = ?')
      .get('sha256:c1') as { text_len: number }
    expect(row.text_len).toBe(5)
  })

  it('字段/上限非法 → 400 {code:2000}', async () => {
    const cases: Array<[string, unknown]> = [
      ['空 samples', base({ samples: [] })],
      ['channel 非法', base({ samples: [sample({ channel: 'manual' })] })],
      ['kind 非法', base({ samples: [sample({ kind: 'other' })] })],
      ['stage 非法', base({ samples: [sample({ stage: 'ai' })] })],
      ['空 content_hash', base({ samples: [sample({ content_hash: '' })] })],
      ['blocked_by 超长', base({ samples: [sample({ blocked_by: 'x'.repeat(121) })] })],
      ['tier 越界', base({ samples: [sample({ tier: 9 })] })],
      ['text 超长', base({ samples: [sample({ text: 'x'.repeat(2001) })] })],
      ['samples > 50', base({ samples: Array.from({ length: 51 }, (_, i) => sample({ content_hash: `h${i}` })) })],
    ]
    for (const [label, payload] of cases) {
      const res = await post(payload)
      expect(res.statusCode, label).toBe(400)
      expect(JSON.parse(res.payload).code, label).toBe(2000)
    }
  })

  it('窗口非法 / 跨度超限 → 400 {code:2000}', async () => {
    const cases: Array<[string, unknown]> = [
      ['不可解析', base({ window_start: 'not-a-time' })],
      ['start > end', base({ window_start: '2026-10-15 00:00:00', window_end: '2026-10-14 00:00:00' })],
      ['跨度 > 31 天', base({ window_start: '2026-01-01 00:00:00', window_end: '2026-12-31 23:59:59' })],
    ]
    for (const [label, payload] of cases) {
      const res = await post(payload)
      expect(res.statusCode, label).toBe(400)
      expect(JSON.parse(res.payload).code, label).toBe(2000)
    }
  })
})
