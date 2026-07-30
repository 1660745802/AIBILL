/**
 * Dashboard 聚合端点集成测试
 * 覆盖: GET /api/stats/dashboard 各个数据段
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Dashboard Route - GET /api/stats/dashboard', () => {
  let app: FastifyInstance
  let userToken: string
  let userCategoryId: number

  beforeAll(async () => {
    app = await buildApp()
    userToken = await createUser(app, 'dashuser')

    // Get user's first expense category
    const catRes = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: authHeaders(userToken),
    })
    const categories = JSON.parse(catRes.payload).data.items
    userCategoryId = categories.find((c: any) => c.type === 'expense').id

    // Create transactions for current month
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const today = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`

    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(userToken),
      payload: {
        items: [
          { client_id: 'd1111111-1111-1111-1111-111111111111', type: 'expense', amount: 3200, category_id: userCategoryId, description: '午饭', date: today },
          { client_id: 'd2222222-2222-2222-2222-222222222222', type: 'expense', amount: 1500, category_id: userCategoryId, description: '打车', date: today },
          { client_id: 'd3333333-3333-3333-3333-333333333333', type: 'income', amount: 1200000, category_id: null, description: '工资', date: today },
        ],
      },
    })

    // Create a budget
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: authHeaders(userToken),
      payload: { category_id: 0, amount: 500000, year: now.getFullYear(), month: now.getMonth() + 1 },
    })
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  it('should return 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
    })
    expect(res.statusCode).toBe(401)
  })

  it('should return dashboard data with correct structure', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const body = JSON.parse(res.payload)

    expect(res.statusCode).toBe(200)
    expect(body.code).toBe(0)

    const data = body.data
    expect(data).toHaveProperty('summary')
    expect(data).toHaveProperty('net_worth')
    expect(data).toHaveProperty('trend_7days')
    expect(data).toHaveProperty('top_categories')
    expect(data).toHaveProperty('budget_progress')
    expect(data).toHaveProperty('alerts')
    expect(data).toHaveProperty('recent_transactions')
  })

  it('should return correct summary data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { summary } = JSON.parse(res.payload).data

    expect(summary.expense).toBe(4700) // 3200 + 1500
    expect(summary.income).toBe(1200000)
    expect(summary.balance).toBe(1200000 - 4700)
    expect(summary.transaction_count).toBe(3)
    // No previous month data, so changes should be null
    expect(summary.expense_change).toBeNull()
    expect(summary.income_change).toBeNull()
  })

  it('should return net_worth with accounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { net_worth } = JSON.parse(res.payload).data

    expect(net_worth).toHaveProperty('total')
    expect(net_worth).toHaveProperty('accounts')
    expect(Array.isArray(net_worth.accounts)).toBe(true)
    // Default accounts have 0 initial balance
    expect(net_worth.total).toBe(0)
    for (const acc of net_worth.accounts) {
      expect(acc).toHaveProperty('id')
      expect(acc).toHaveProperty('name')
      expect(acc).toHaveProperty('icon')
      expect(acc).toHaveProperty('balance')
    }
  })

  it('should return 7-day trend with correct length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { trend_7days } = JSON.parse(res.payload).data

    expect(trend_7days).toHaveLength(7)
    for (const item of trend_7days) {
      expect(item).toHaveProperty('date')
      expect(item).toHaveProperty('total')
      expect(typeof item.total).toBe('number')
    }

    // Today should have expense data
    const todayEntry = trend_7days[trend_7days.length - 1]
    expect(todayEntry.total).toBe(4700)
  })

  it('should return top categories', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { top_categories } = JSON.parse(res.payload).data

    expect(Array.isArray(top_categories)).toBe(true)
    expect(top_categories.length).toBeGreaterThan(0)
    expect(top_categories.length).toBeLessThanOrEqual(5)

    for (const cat of top_categories) {
      expect(cat).toHaveProperty('name')
      expect(cat).toHaveProperty('icon')
      expect(cat).toHaveProperty('total')
      expect(cat).toHaveProperty('percent')
    }

    // All spending is in one category, so percent should be 100
    expect(top_categories[0].percent).toBe(100)
    expect(top_categories[0].total).toBe(4700)
  })

  it('should return budget progress', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { budget_progress } = JSON.parse(res.payload).data

    expect(Array.isArray(budget_progress)).toBe(true)
    expect(budget_progress.length).toBeGreaterThan(0)

    const totalBudget = budget_progress.find((b: any) => b.category_name === '总预算')
    expect(totalBudget).toBeDefined()
    expect(totalBudget.amount).toBe(500000)
    expect(totalBudget.spent).toBe(4700)
    expect(totalBudget.percent).toBe(1) // 4700/500000 ≈ 0.94% -> rounds to 1
    expect(totalBudget.status).toBe('normal')
    expect(totalBudget).toHaveProperty('category_icon')
  })

  it('should return alerts array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { alerts } = JSON.parse(res.payload).data

    expect(Array.isArray(alerts)).toBe(true)
    // With small amounts, no large_expense or budget_warning expected
  })

  it('should return recent transactions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { recent_transactions } = JSON.parse(res.payload).data

    expect(Array.isArray(recent_transactions)).toBe(true)
    expect(recent_transactions.length).toBe(3) // We created 3 transactions

    for (const tx of recent_transactions) {
      expect(tx).toHaveProperty('id')
      expect(tx).toHaveProperty('type')
      expect(tx).toHaveProperty('amount')
      expect(tx).toHaveProperty('date')
    }
  })

  it('should trigger budget_warning alert when spending is high', async () => {
    // Create a tight budget that will be exceeded
    const now = new Date()
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: authHeaders(userToken),
      payload: { category_id: userCategoryId, amount: 5000, year: now.getFullYear(), month: now.getMonth() + 1 },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
      headers: authHeaders(userToken),
    })
    const { alerts, budget_progress } = JSON.parse(res.payload).data

    // 4700 out of 5000 = 94%, should trigger warning
    const catBudget = budget_progress.find((b: any) => b.category_name !== '总预算')
    expect(catBudget).toBeDefined()
    expect(catBudget.status).toBe('warning')
    expect(catBudget.percent).toBe(94)

    const budgetAlert = alerts.find((a: any) => a.type === 'budget_warning')
    expect(budgetAlert).toBeDefined()
    expect(budgetAlert.message).toContain('94%')
  })
})
