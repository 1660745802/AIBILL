/**
 * `GET /api/admin/ai-parse-stats` 的**失败可观测**块（022）
 *
 * 客户端把「解析失败 → 落待审」收紧为「失败不打扰用户」后，用户视野里看不到失败，
 * 于是「AI 挂了」只能靠管理面板发现。本用例锁住：
 *
 *   1. 「判非账」（`status='empty'` 且 `failure_code IS NULL`）**不算失败**——
 *      旧口径把 empty 计入非成功，等于把「AI 正确回答『这不是账』」当故障；
 *   2. `unavailable_count` = error + timeout；`by_failure_code` 按原因分布；
 *   3. `by_channel` 按渠道拆分（channel 为 NULL 的老 APK 归 `unknown`）；
 *   4. `retried_count` / `retry_rescued` 让「重试救回了多少」可量化。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('admin/ai-parse-stats 的失败可观测块', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'failobs')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id

    const ins = getDb().prepare(
      `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, attempts, channel)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    ins.run(userId, 'a', 'success', null, 2, 'nls') // 重试救回
    ins.run(userId, 'b', 'success', null, 1, 'nls')
    ins.run(userId, 'c', 'empty', null, 1, 'a11y') // AI 判非账（不是失败）
    ins.run(userId, 'd', 'error', 'AI_TIMEOUT', 2, 'a11y') // 重试后仍超时
    ins.run(userId, 'e', 'timeout', 'AI_TIMEOUT', 1, null) // 老客户端无 channel
    ins.run(userId, 'f', 'error', 'parse_format', 2, 'sms')
    ins.run(userId, 'g', 'error', 'input_empty', 0, 'nls') // 入参类：是失败，但**不是「AI 挂了」**
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const fetchStats = () =>
    app.inject({ method: 'GET', url: '/api/admin/ai-parse-stats?days=30', headers: authHeaders(adminToken) })

  it('overview：判非账不计失败；入参类失败也不计「AI 挂了」', async () => {
    const data = JSON.parse((await fetchStats()).payload).data
    const o = data.overview
    expect(o.total).toBe(7)
    expect(o.success_count).toBe(2)
    expect(o.not_a_bill_count).toBe(1)
    expect(o.unavailable_count).toBe(3) // error + timeout，**不含** input_empty
    expect(o.unavailable_rate).toBeCloseTo(42.86, 1) // 3/7
    expect(o.not_a_bill_rate).toBeCloseTo(14.29, 1)
    expect(o.retried_count).toBe(3) // a / d / f
    expect(o.retry_rescued).toBe(1) // a：重试后成功
    // 判非账**不**进 unavailable
    expect(o.unavailable_count).not.toBe(4)
  })

  it('by_failure_code：按原因分布（入参类也在，否则就是黑洞）', async () => {
    const data = JSON.parse((await fetchStats()).payload).data
    const map = Object.fromEntries((data.by_failure_code as Array<{ failure_code: string; count: number }>).map((r) => [r.failure_code, r.count]))
    expect(map).toEqual({ AI_TIMEOUT: 2, parse_format: 1, input_empty: 1 })
  })

  it('by_channel：渠道拆分 + NULL 归 unknown + 每渠道不可用率', async () => {
    const data = JSON.parse((await fetchStats()).payload).data
    const byChannel = Object.fromEntries((data.by_channel as any[]).map((c) => [c.channel, c]))
    expect(byChannel.nls).toMatchObject({ total: 3, success_count: 2, unavailable_count: 0 }) // input_empty 不算不可用
    expect(byChannel.a11y).toMatchObject({ total: 2, not_a_bill_count: 1, unavailable_count: 1 })
    expect(byChannel.a11y.unavailable_rate).toBe(50)
    expect(byChannel.sms).toMatchObject({ total: 1, unavailable_count: 1 })
    expect(byChannel.unknown).toMatchObject({ total: 1, unavailable_count: 1 })
  })

  it('recent_failures 带 failure_code / attempts / channel（排障要看得到原因）', async () => {
    const data = JSON.parse((await fetchStats()).payload).data
    expect(data.recent_failures.length).toBeGreaterThanOrEqual(3)
    for (const f of data.recent_failures) {
      expect(f).toHaveProperty('failure_code')
      expect(f).toHaveProperty('attempts')
      expect(f).toHaveProperty('channel')
    }
  })
})
