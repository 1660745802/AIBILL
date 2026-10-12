/**
 * `GET /api/admin/ai-parse-stats` 的**服务端预筛**块（本轮补上的可视化缺口）
 *
 * 背景：`lib/parse-filter.ts` 的 `filterStats()` 此前**无任何消费者** —— 即
 * 「服务端预筛挡掉了多少通知」（线上 53%）既没有接口也没有界面，只能手工 SQL。
 * 本用例锁住它被接进 admin 统计、且计数随 `ai_parse_filters` 变化。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('admin/ai-parse-stats 的 prefilter 块', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'prefilterstat')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  const fetchStats = (days = 30) =>
    app.inject({ method: 'GET', url: `/api/admin/ai-parse-stats?days=${days}`, headers: authHeaders(adminToken) })

  it('普通用户无权访问（403）', async () => {
    const token = await createUser(app, 'prefilterstat2')
    const res = await app.inject({ method: 'GET', url: '/api/admin/ai-parse-stats', headers: authHeaders(token) })
    expect(res.statusCode).toBe(403)
  })

  it('返回 prefilter 块，且与 ai_parse_filters 的实际行数一致（含 byReason 分档）', async () => {
    const before = JSON.parse((await fetchStats()).payload).data.prefilter
    expect(before).toBeTruthy()
    for (const k of ['total', 'inbound', 'outbound', 'medianMs', 'maxMs', 'byReason', 'days', 'perDay']) {
      expect(before, `prefilter.${k} 缺失`).toHaveProperty(k)
    }

    // 造两条入站拦截 + 一条出站判定
    const ins = getDb().prepare(
      `INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    ins.run(userId, '双11 5折', 'inbound', 0, JSON.stringify(['marketing']), 1)
    ins.run(userId, '0元领', 'inbound', 0, JSON.stringify(['zero_yuan']), 2)
    ins.run(userId, '某长文本', 'outbound', 2, JSON.stringify(['no_corroboration']), 3)

    const after = JSON.parse((await fetchStats()).payload).data.prefilter
    expect(after.total).toBe(before.total + 3)
    expect(after.inbound).toBe(before.inbound + 2)
    expect(after.outbound).toBe(before.outbound + 1)
    const reasons = (after.byReason as Array<{ reason: string; count: number }>).map((r) => r.reason)
    expect(reasons).toContain('marketing')
    expect(reasons).toContain('zero_yuan')
    expect(reasons).toContain('no_corroboration')
    // 判定耗时是「纯字符串匹配」，必须是毫秒级（DATA §10.4 的口径）
    expect(after.maxMs).toBeLessThan(1000)
  })
})
