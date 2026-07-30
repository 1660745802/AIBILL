/**
 * 订阅管理路由集成测试
 * 覆盖: 创建(monthly/quarterly/yearly)、列表、月年总额计算、更新、取消续订、删除、用户隔离、next_payment_date
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Subscription Routes', () => {
  let app: FastifyInstance
  let userToken: string
  let user2Token: string
  let userCategoryId: number
  let userAccountId: number

  beforeAll(async () => {
    app = await buildApp()
    userToken = await createUser(app, 'subuser1')
    user2Token = await createUser(app, 'subuser2')

    // Get user's first category
    const catRes = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: authHeaders(userToken),
    })
    const categories = JSON.parse(catRes.payload).data.items
    userCategoryId = categories.find((c: any) => c.type === 'expense').id

    // Get user's first account
    const accRes = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: authHeaders(userToken),
    })
    const accounts = JSON.parse(accRes.payload).data.items
    userAccountId = accounts[0].id
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/subscriptions', () => {
    it('should create a monthly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Netflix',
          amount: 1500,
          cycle: 'monthly',
          category_id: userCategoryId,
          account_id: userAccountId,
          start_date: '2026-01-01',
          reminder_days: 3,
          auto_record: false,
          note: '视频会员',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.name).toBe('Netflix')
      expect(body.data.amount).toBe(1500)
      expect(body.data.cycle).toBe('monthly')
      expect(body.data.next_payment_date).toBeDefined()
    })

    it('should create a quarterly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'iCloud 存储',
          amount: 2100,
          cycle: 'quarterly',
          start_date: '2026-01-15',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.cycle).toBe('quarterly')
    })

    it('should create a yearly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'GitHub Pro',
          amount: 48000,
          cycle: 'yearly',
          start_date: '2026-03-01',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.cycle).toBe('yearly')
    })

    it('should reject invalid amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Bad',
          amount: -100,
          cycle: 'monthly',
          start_date: '2026-01-01',
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should reject invalid category', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Bad Cat',
          amount: 1000,
          cycle: 'monthly',
          category_id: 99999,
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(400)
      expect(body.code).toBe(2003)
    })
  })

  describe('GET /api/subscriptions', () => {
    it('should list active subscriptions by default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBe(3)
      // All should have category_name or null
      for (const item of body.data.items) {
        expect(item).toHaveProperty('category_name')
        expect(item).toHaveProperty('account_name')
      }
    })

    it('should list all subscriptions when status=all', async () => {
      // First cancel one
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[items.length - 1].id

      await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/cancel`,
        headers: authHeaders(userToken),
      })

      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.data.items.length).toBe(3)

      // Active only should be 2
      const activeRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=active',
        headers: authHeaders(userToken),
      })
      const activeBody = JSON.parse(activeRes.payload)
      expect(activeBody.data.items.length).toBe(2)

      // Renew it back for subsequent tests
      await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/renew`,
        headers: authHeaders(userToken),
      })
    })

    it('should compute monthly_total and yearly_total', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)

      // Netflix monthly: 1500/month, 18000/year
      // iCloud quarterly: 2100/3=700/month, 2100*4=8400/year
      // GitHub yearly: 48000/12=4000/month, 48000/year
      const expectedMonthly = 1500 + Math.round(2100 / 3) + Math.round(48000 / 12)
      const expectedYearly = 1500 * 12 + 2100 * 4 + 48000

      expect(body.data.monthly_total).toBe(expectedMonthly)
      expect(body.data.yearly_total).toBe(expectedYearly)
    })
  })

  describe('PUT /api/subscriptions/:id', () => {
    it('should update subscription name and amount', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[0].id

      const res = await app.inject({
        method: 'PUT',
        url: `/api/subscriptions/${subId}`,
        headers: authHeaders(userToken),
        payload: { name: 'Netflix Premium', amount: 2500 },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.name).toBe('Netflix Premium')
      expect(body.data.amount).toBe(2500)
    })

    it('should recalculate next_payment_date when cycle changes', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const sub = items[0]
      const oldNext = sub.next_payment_date

      const res = await app.inject({
        method: 'PUT',
        url: `/api/subscriptions/${sub.id}`,
        headers: authHeaders(userToken),
        payload: { cycle: 'yearly' },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      // next_payment_date should be different since cycle changed
      expect(body.data.next_payment_date).not.toBe(oldNext)
    })

    it('should return 404 for non-existent subscription', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/subscriptions/99999',
        headers: authHeaders(userToken),
        payload: { name: 'Nonexistent' },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /api/subscriptions/:id/cancel', () => {
    it('should cancel a subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[0].id

      const res = await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/cancel`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)

      // Verify it's cancelled
      const allRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=cancelled',
        headers: authHeaders(userToken),
      })
      const allBody = JSON.parse(allRes.payload)
      const cancelled = allBody.data.items.find((s: any) => s.id === subId)
      expect(cancelled).toBeDefined()
      expect(cancelled.status).toBe('cancelled')
    })
  })

  describe('POST /api/subscriptions/:id/renew', () => {
    it('should renew a cancelled subscription', async () => {
      const allRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=cancelled',
        headers: authHeaders(userToken),
      })
      const cancelled = JSON.parse(allRes.payload).data.items[0]

      const res = await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${cancelled.id}/renew`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.status).toBe('active')
      expect(body.data.next_payment_date).toBeDefined()
    })
  })

  describe('DELETE /api/subscriptions/:id', () => {
    it('should delete a subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[items.length - 1].id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/subscriptions/${subId}`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)

      // Verify it's gone
      const afterRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const afterItems = JSON.parse(afterRes.payload).data.items
      expect(afterItems.find((s: any) => s.id === subId)).toBeUndefined()
    })

    it('should return 404 for non-existent subscription', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/subscriptions/99999',
        headers: authHeaders(userToken),
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('User isolation', () => {
    it('should not allow user2 to see user1 subscriptions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(user2Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.data.items.length).toBe(0)
    })

    it('should not allow user2 to update user1 subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      if (items.length > 0) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/subscriptions/${items[0].id}`,
          headers: authHeaders(user2Token),
          payload: { name: 'Hacked' },
        })
        expect(res.statusCode).toBe(404)
      }
    })

    it('should not allow user2 to delete user1 subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      if (items.length > 0) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/subscriptions/${items[0].id}`,
          headers: authHeaders(user2Token),
        })
        expect(res.statusCode).toBe(404)
      }
    })
  })

  describe('next_payment_date calculation', () => {
    it('should calculate correct next_payment_date for monthly subscription', async () => {
      // Use a start_date in the past
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Monthly Test',
          amount: 1000,
          cycle: 'monthly',
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      // next_payment_date should be in the future
      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // It should be within the next month from now (at most)
      const oneMonthLater = new Date(now)
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1)
      oneMonthLater.setDate(oneMonthLater.getDate() + 1) // buffer
      expect(nextDate.getTime()).toBeLessThanOrEqual(oneMonthLater.getTime())
    })

    it('should calculate correct next_payment_date for quarterly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Quarterly Test',
          amount: 3000,
          cycle: 'quarterly',
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // Should be within next 3 months
      const threeMonthsLater = new Date(now)
      threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3)
      threeMonthsLater.setDate(threeMonthsLater.getDate() + 1)
      expect(nextDate.getTime()).toBeLessThanOrEqual(threeMonthsLater.getTime())
    })

    it('should calculate correct next_payment_date for yearly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Yearly Test',
          amount: 12000,
          cycle: 'yearly',
          start_date: '2025-06-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // Should be within next 12 months
      const oneYearLater = new Date(now)
      oneYearLater.setMonth(oneYearLater.getMonth() + 12)
      oneYearLater.setDate(oneYearLater.getDate() + 1)
      expect(nextDate.getTime()).toBeLessThanOrEqual(oneYearLater.getTime())
    })

    it('should set future start_date as next_payment_date', async () => {
      // If start_date is in the future, next_payment_date = start_date
      const futureDate = new Date()
      futureDate.setMonth(futureDate.getMonth() + 2)
      const futureDateStr = futureDate.toISOString().slice(0, 10)

      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Future Sub',
          amount: 5000,
          cycle: 'monthly',
          start_date: futureDateStr,
        },
      })
      const body = JSON.parse(res.payload)
      // Since start_date is in the future, it never enters the while loop
      // so next_payment_date should be the start_date itself
      expect(body.data.next_payment_date).toBe(futureDateStr)
    })
  })
})
