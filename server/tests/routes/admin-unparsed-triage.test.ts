/**
 * `POST /api/admin/unparsed/:id/triage` —— P2 人工裁决（docs/ARCHITECTURE.md §3.9）
 *
 * 锁住：
 *   1. 只允许裁决「不确定」失败记录（unavailable 集合）；入参类 / 非失败 / 不存在 → 404；
 *   2. **幂等**：同 (parse_log_id, admin_id, action) 重复提交 = 成功且不新增行；不同 action 允许；
 *   3. **绝不写 transactions、绝不改 `ai_parse_logs`**（机器事实与人工意见分开）；
 *   4. P1 列表带出「当前态」裁决 + `?triage=` 候选池过滤；
 *   5. 删除用户时裁决行被清理（不因 FK 卡住删用户）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('admin/unparsed triage（P2 裁决）', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number
  let logA: number
  let logB: number
  let logInput: number
  let logSuccess: number

  const insertLog = (uid: number, status: string, failure: string | null): number =>
    Number(
      getDb()
        .prepare(
          `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, channel)
           VALUES (?, ?, ?, ?, 'nls')`,
        )
        .run(uid, '微信支付 已支付 ¥32.50', status, failure).lastInsertRowid,
    )

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'triageuser')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id

    logA = insertLog(userId, 'timeout', 'AI_TIMEOUT')
    logB = insertLog(userId, 'error', 'parse_format')
    logInput = insertLog(userId, 'error', 'input_empty') // 入参类：不是「不确定」
    logSuccess = insertLog(userId, 'success', null)
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (id: number | string, payload: unknown, t = adminToken) =>
    app.inject({ method: 'POST', url: `/api/admin/unparsed/${id}/triage`, headers: authHeaders(t), payload: payload as never })
  const list = (qs = '?days=90') =>
    app.inject({ method: 'GET', url: `/api/admin/unparsed${qs}`, headers: authHeaders(adminToken) })

  it('普通用户 → 403', async () => {
    const token = await createUser(app, 'triageuser2')
    const res = await post(logA, { action: 'mark_bill', reason: 'x' }, token)
    expect(res.statusCode).toBe(403)
  })

  it('入参校验：非法 action / 空 reason / 非法 id → 400', async () => {
    expect((await post(logA, { action: 'write_transaction', reason: 'x' })).statusCode).toBe(400)
    expect((await post(logA, { action: 'mark_bill', reason: '' })).statusCode).toBe(400)
    expect((await post('abc', { action: 'mark_bill', reason: 'x' })).statusCode).toBe(400)
  })

  it('只裁决「不确定」失败记录：不存在 / 入参类 / 非失败 → 404', async () => {
    expect((await post(99999, { action: 'mark_bill', reason: 'x' })).statusCode).toBe(404)
    expect((await post(logInput, { action: 'mark_bill', reason: 'x' })).statusCode).toBe(404)
    expect((await post(logSuccess, { action: 'mark_bill', reason: 'x' })).statusCode).toBe(404)
  })

  it('mark_bill 落库 + 幂等 + 不写 transactions / 不改 ai_parse_logs', async () => {
    const before = getDb().prepare('SELECT status, failure_code, raw_input FROM ai_parse_logs WHERE id = ?').get(logA)

    const first = await post(logA, { action: 'mark_bill', reason: '金额+商户完整，是真账' })
    expect(first.statusCode).toBe(200)
    const b1 = JSON.parse(first.payload)
    expect(b1.code).toBe(0)
    expect(b1.data).toMatchObject({ parse_log_id: logA, action: 'mark_bill', created: true })

    // 幂等：同 action 重复提交 → created=false，仍只有一行
    const again = JSON.parse((await post(logA, { action: 'mark_bill', reason: '重复' })).payload)
    expect(again.data.created).toBe(false)
    const rows = getDb()
      .prepare(`SELECT COUNT(*) c FROM admin_unparsed_triage WHERE parse_log_id = ? AND action = 'mark_bill'`)
      .get(logA) as { c: number }
    expect(rows.c).toBe(1)

    // 绝不写账、绝不改机器事实
    const txCount = (getDb().prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c
    expect(txCount).toBe(0)
    expect(getDb().prepare('SELECT status, failure_code, raw_input FROM ai_parse_logs WHERE id = ?').get(logA)).toEqual(before)
  })

  it('同 log 不同 action 允许；列表带当前态 + ?triage= 候选池过滤', async () => {
    await post(logB, { action: 'mark_rule_missing', reason: '这类短信没判据' })
    await post(logB, { action: 'mark_not_bill', reason: '其实是广告' })

    const rows = getDb()
      .prepare('SELECT COUNT(*) c FROM admin_unparsed_triage WHERE parse_log_id = ?')
      .get(logB) as { c: number }
    expect(rows.c).toBe(2) // 历史不删

    // 当前态 = 最新一行（mark_not_bill）
    const data = JSON.parse((await list('?days=90&failure_code=parse_format')).payload).data
    const item = data.items.find((i: any) => i.id === logB)
    expect(item.triage).toMatchObject({ action: 'mark_not_bill', reason: '其实是广告' })

    // 候选池过滤按「当前态」，不是按历史
    const notBill = JSON.parse((await list('?days=90&triage=mark_not_bill')).payload).data
    expect(notBill.items.map((i: any) => i.id)).toContain(logB)
    const ruleMissing = JSON.parse((await list('?days=90&triage=mark_rule_missing')).payload).data
    expect(ruleMissing.items.map((i: any) => i.id)).not.toContain(logB) // 已被改判
    const badTriage = await list('?days=90&triage=bogus')
    expect(badTriage.statusCode).toBe(400)
  })

  it('删除有裁决记录的用户成功（FK 清理不卡删用户）', async () => {
    const token = await createUser(app, 'triagevictim')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    const victimId = JSON.parse(me.payload).data.user.id
    const victimLog = insertLog(victimId, 'timeout', 'AI_TIMEOUT')
    await post(victimLog, { action: 'mark_bill', reason: 'x' })

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victimId}`,
      headers: authHeaders(adminToken),
    })
    expect(res.statusCode).toBe(200)
    const left = getDb()
      .prepare('SELECT COUNT(*) c FROM admin_unparsed_triage WHERE parse_log_id = ?')
      .get(victimLog) as { c: number }
    expect(left.c).toBe(0)
  })
})
