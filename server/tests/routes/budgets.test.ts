/**
 * 预算路由集成测试
 * 覆盖: 创建预算、获取预算（含用量计算）、修改、删除
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Budget Routes', () => {
  let app: FastifyInstance
  let userToken: string
  let userCategoryId: number

  beforeAll(async () => {
    app = await buildApp()
    userToken = await createUser(app, 'budgetuser')

    // Get user's first category (auto-created on registration)
    const catRes = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: authHeaders(userToken),
    })
    const categories = JSON.parse(catRes.payload).data.items
    userCategoryId = categories.find((c: any) => c.type === 'expense').id

    // Create some transactions so budget has spending data
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(userToken),
      payload: {
        items: [
          { client_id: 'b1111111-1111-1111-1111-111111111111', type: 'expense', amount: 5000, category_id: userCategoryId, description: '午饭', date: '2026-07-15' },
          { client_id: 'b2222222-2222-2222-2222-222222222222', type: 'expense', amount: 3000, category_id: userCategoryId, description: '晚饭', date: '2026-07-20' },
          // 非请求月（3 月）：全年预算应计入，月度预算不应计入——用来鉴别两个区间
          { client_id: 'b3333333-3333-3333-3333-333333333333', type: 'expense', amount: 2000, category_id: userCategoryId, description: '三月午饭', date: '2026-03-05' },
        ],
      },
    })
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/budgets', () => {
    it('should create a total monthly budget', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/budgets',
        headers: authHeaders(userToken),
        payload: { category_id: 0, amount: 500000, year: 2026, month: 7 },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
    })

    it('非安全整数金额应被拒（否则 SQLite 把 INTEGER 列存成 REAL）', async () => {
      for (const amount of [1e20, 9007199254740993]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/budgets',
          headers: authHeaders(userToken),
          payload: { category_id: 0, amount, year: 2026, month: 8 },
        })
        expect(res.statusCode, String(amount)).toBe(400)
        expect(JSON.parse(res.payload).code).toBe(2000)
      }
      // PUT 也要拦
      const list = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/budgets?year=2026&month=7', headers: authHeaders(userToken) })).payload,
      ).data.items
      const res = await app.inject({
        method: 'PUT',
        url: `/api/budgets/${list[0].id}`,
        headers: authHeaders(userToken),
        payload: { amount: 1e20 },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should create a category budget', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/budgets',
        headers: authHeaders(userToken),
        payload: { category_id: userCategoryId, amount: 100000, year: 2026, month: 7 },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
    })
  })

  describe('GET /api/budgets', () => {
    it('should list budgets with spending data', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budgets?year=2026&month=7',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBeGreaterThanOrEqual(1)

      // Total budget should have spending > 0 (from transactions created in setup)
      const totalBudget = body.data.items.find((b: any) => b.category_id === 0)
      if (totalBudget) {
        expect(totalBudget.spent).toBeGreaterThan(0)
        expect(totalBudget.percent).toBeGreaterThan(0)
      }
    })

    it('全年预算（month=0）的 spent 按全年区间，不是请求月份', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/budgets',
        headers: authHeaders(userToken),
        payload: { category_id: 0, amount: 500000, period: 'yearly', year: 2026, month: 0 },
      })
      const res = await app.inject({
        method: 'GET',
        url: '/api/budgets?year=2026&month=7',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(res.payload).data.items
      const yearly = items.find((b: any) => b.month === 0 && b.category_id === 0)
      expect(yearly).toBeDefined()
      // 7 月 5000+3000 + 3 月 2000 = 10000；旧实现只算 7 月 → 8000
      expect(yearly.spent).toBe(10000)
    })

    it('should show category budget with correct spending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/budgets?year=2026&month=7',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      const catBudget = body.data.items.find((b: any) => b.category_id === userCategoryId)
      expect(catBudget).toBeDefined()
      expect(catBudget.spent).toBe(8000) // 5000 + 3000
    })
  })

  describe('DELETE /api/budgets/:id', () => {
    it('should delete a budget', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/budgets?year=2026&month=7',
        headers: authHeaders(userToken),
      })
      const budgets = JSON.parse(listRes.payload).data.items
      const budgetId = budgets[budgets.length - 1].id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/budgets/${budgetId}`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
    })
  })
})
