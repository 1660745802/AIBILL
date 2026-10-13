/**
 * `GET /api/admin/unparsed` —— 「不确定」集中裁决面 · P1 只读（docs/ARCHITECTURE.md §3.9）
 *
 * 锁住：
 *   1. 只返回 `failure_code` ∈ **unavailable 集合**（真源 lib/ai-failure.ts）：排除
 *      `input_empty` / `input_too_long`（入参类）与 `failure_code IS NULL`；
 *   2. 窗口 / channel / failure_code / user_id / 分页过滤；
 *   3. **默认脱敏**（只给首 60 字 `text_preview` + `raw_input_len`）；`include_raw=1` 才给全文；
 *   4. 读原文**写审计**（与解析日志列表同口径）；
 *   5. summary 的 by_failure_code / by_channel。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('admin/unparsed（P1 只读）', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number
  let idTimeout: number
  let idFormat: number

  const LONG = '微信支付 已支付 ¥32.50 商户：某某小吃店 ' + 'x'.repeat(80)

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'unparseduser')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id

    // 窗口内的行用默认 created_at（now），避免把测试绑死在某个具体日期上
    const ins = getDb().prepare(
      `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, attempts, channel)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    idTimeout = Number(ins.run(userId, LONG, 'timeout', 'AI_TIMEOUT', 2, 'a11y').lastInsertRowid)
    idFormat = Number(ins.run(userId, '消费 50.00 元', 'error', 'parse_format', 1, 'nls').lastInsertRowid)
    // 入参类：不是「AI 挂了」，**不进裁决面**
    ins.run(userId, '', 'error', 'input_empty', 0, 'nls')
    // 没有失败：不是 unparsed
    ins.run(userId, '微信支付 已支付 ¥1.00', 'success', null, 1, 'nls')
    // 窗口之外
    getDb()
      .prepare(
        `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, attempts, channel, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '2000-01-01 00:00:00')`,
      )
      .run(userId, '旧记录', 'timeout', 'AI_TIMEOUT', 1, 'a11y')
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const get = (qs: string) =>
    app.inject({ method: 'GET', url: `/api/admin/unparsed${qs}`, headers: authHeaders(adminToken) })

  it('普通用户 → 403', async () => {
    const token = await createUser(app, 'unparseduser2')
    const res = await app.inject({ method: 'GET', url: '/api/admin/unparsed', headers: authHeaders(token) })
    expect(res.statusCode).toBe(403)
  })

  it('只返回 unavailable 集合（排除入参类与无失败），且按时间倒序', async () => {
    const data = JSON.parse((await get('?days=90')).payload).data
    expect(data.summary.total).toBe(2)
    expect(data.items.map((i: any) => i.id)).toEqual([idFormat, idTimeout]) // created_at DESC
    for (const it of data.items) {
      expect(it.failure_code).not.toBe('input_empty')
      expect(it.failure_code).not.toBe('input_too_long')
      expect(it.failure_code).not.toBeNull()
    }
  })

  it('summary：by_failure_code / by_channel', async () => {
    const data = JSON.parse((await get('?days=90')).payload).data
    const byCode = Object.fromEntries(data.summary.by_failure_code.map((r: any) => [r.failure_code, r.count]))
    expect(byCode).toEqual({ AI_TIMEOUT: 1, parse_format: 1 })
    const byCh = Object.fromEntries(data.summary.by_channel.map((r: any) => [r.channel, r.count]))
    expect(byCh).toEqual({ a11y: 1, nls: 1 })
  })

  it('默认脱敏：只给 text_preview（首 60 字）+ raw_input_len，raw_input 为 null', async () => {
    const data = JSON.parse((await get('?days=90&failure_code=AI_TIMEOUT')).payload).data
    const it = data.items[0]
    expect(it.raw_input).toBeNull()
    expect(it.raw_input_len).toBe(LONG.length)
    expect(it.text_preview.endsWith('…')).toBe(true)
    expect(it.text_preview.length).toBe(61) // 60 + 省略号
    expect(LONG.startsWith(it.text_preview.slice(0, 60))).toBe(true)
  })

  it('include_raw=1 → 给全文并写审计', async () => {
    const before = (getDb().prepare(`SELECT COUNT(*) c FROM app_logs WHERE module='admin' AND message LIKE '%查看未解析原文%'`).get() as { c: number }).c
    const data = JSON.parse((await get('?days=90&include_raw=1')).payload).data
    expect(data.include_raw).toBe(true)
    const it = data.items.find((x: any) => x.id === idTimeout)
    expect(it.raw_input).toBe(LONG)
    const after = (getDb().prepare(`SELECT COUNT(*) c FROM app_logs WHERE module='admin' AND message LIKE '%查看未解析原文%'`).get() as { c: number }).c
    expect(after).toBe(before + 1)
  })

  it('过滤：channel / failure_code（逗号多值）/ user_id', async () => {
    expect(JSON.parse((await get('?days=90&channel=nls')).payload).data.items.map((i: any) => i.id)).toEqual([idFormat])
    expect(JSON.parse((await get('?days=90&failure_code=AI_TIMEOUT')).payload).data.items.map((i: any) => i.id)).toEqual([idTimeout])
    expect(JSON.parse((await get('?days=90&failure_code=AI_TIMEOUT,parse_format')).payload).data.summary.total).toBe(2)
    expect(JSON.parse((await get(`?days=90&user_id=${userId}`)).payload).data.summary.total).toBe(2)
    expect(JSON.parse((await get('?days=90&user_id=99999')).payload).data.summary.total).toBe(0)
  })

  it('窗口 days：窗口外的旧记录从不出现', async () => {
    const data = JSON.parse((await get('?days=90')).payload).data
    expect(data.items.some((i: any) => i.text_preview === '旧记录')).toBe(false)
  })

  it('分页：page_size=1 → 1 条 + total/total_pages 正确', async () => {
    const data = JSON.parse((await get('?days=90&page=2&page_size=1')).payload).data
    expect(data.items).toHaveLength(1)
    expect(data.pagination).toMatchObject({ page: 2, page_size: 1, total: 2, total_pages: 2 })
  })

  it('非法参数 → 400（failure_code 越集 / channel / user_id）', async () => {
    expect((await get('?failure_code=bogus')).statusCode).toBe(400)
    expect((await get('?failure_code=input_empty')).statusCode).toBe(400) // 入参类不在集合
    expect((await get('?channel=bogus')).statusCode).toBe(400)
    expect((await get('?user_id=abc')).statusCode).toBe(400)
  })
})
