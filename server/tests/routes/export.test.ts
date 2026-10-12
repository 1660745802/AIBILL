/**
 * 导出路由集成测试
 *
 * 重点：CSV 是给 Excel 打开的，字段内容来自第三方账单商户名与 AI 解析的文本。
 * 以 = + - @ 开头的字段会被 Excel 当公式执行（CSV 公式注入 / DDE），
 * 所以导出前必须中和掉。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Export Routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'exporter')
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(token),
      payload: {
        items: [
          { type: 'expense', amount: 3250, date: '2026-07-02', description: '午饭' },
          { type: 'expense', amount: 100, date: '2026-07-03', description: '=cmd|\' /C calc\'!A1' },
          { type: 'income', amount: 200, date: '2026-07-04', description: '@SUM(1+1)*cmd|calc' },
          { type: 'expense', amount: 300, date: '2026-07-05', description: '逗号,引号"换行\n都要转义' },
        ],
      },
    })
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  it('CSV 带 UTF-8 BOM，且列头固定', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/csv', headers: authHeaders(token) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.payload.startsWith('\uFEFF')).toBe(true)
    expect(res.payload.split('\n')[0]!.slice(1)).toBe('日期,类型,金额(元),分类,账户,描述')
  })

  it('公式注入：= + - @ 开头的描述不得以原样出现在单元格开头', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/csv', headers: authHeaders(token) })

    // 危险样本被前半单引号中和（Excel/Sheets 就不会把它当公式）
    expect(res.payload).toContain("'=cmd")
    expect(res.payload).toContain("'@SUM")
    // 且原样的公式开头不在任何单元格开头出现
    expect(res.payload).not.toContain(',=cmd')
    expect(res.payload).not.toContain(',@SUM')
    expect(res.payload).not.toMatch(/\n\s*=\s*cmd/)
    // 普通描述不受影响（不该给所有人都加单引号）
    expect(res.payload).toContain('午饭')
    expect(res.payload).not.toContain("'午饭")
  })

  it('包含逗号/引号/换行的字段应被双引号包裹并转义', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/csv', headers: authHeaders(token) })
    expect(res.payload).toContain('"逗号,引号""换行')
  })

  it('JSON 导出只含本人数据，且不改动原文（中和只针对 CSV）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/json', headers: authHeaders(token) })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.transactions).toHaveLength(4)
    expect(body.transactions.map((t: { description: string }) => t.description)).toContain("=cmd|' /C calc'!A1")
    expect(body.categories.length).toBeGreaterThan(0)
  })
})
