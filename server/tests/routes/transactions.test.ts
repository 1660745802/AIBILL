/**
 * 交易路由集成测试
 * 覆盖: 批量创建、幂等、用户隔离、查询筛选、修改、软删除、回收站
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Transaction Routes', () => {
  let app: FastifyInstance
  let userToken: string
  let user2Token: string

  beforeAll(async () => {
    app = await buildApp()
    userToken = await createUser(app, 'txuser1')
    user2Token = await createUser(app, 'txuser2')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/transactions', () => {
    it('should create a single transaction', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{
            client_id: '11111111-1111-1111-1111-111111111111',
            type: 'expense',
            amount: 3200,
            description: '午饭',
            date: '2026-07-30',
          }],
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.created).toHaveLength(1)
      expect(body.data.created[0].amount).toBe(3200)
    })

    it('should create multiple transactions in batch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [
            { client_id: '22222222-2222-2222-2222-222222222222', type: 'expense', amount: 1500, description: '咖啡', date: '2026-07-30' },
            { client_id: '33333333-3333-3333-3333-333333333333', type: 'income', amount: 1200000, description: '工资', date: '2026-07-30' },
          ],
        },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.created).toHaveLength(2)
    })

    it('should handle idempotent submission (same client_id)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{
            client_id: '11111111-1111-1111-1111-111111111111',
            type: 'expense',
            amount: 3200,
            description: '午饭',
            date: '2026-07-30',
          }],
        },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      // Should report as duplicate, not create a new one
      expect(body.data.duplicates).toHaveLength(1)
      expect(body.data.created).toHaveLength(0)
    })

    it('should reject invalid amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{
            type: 'expense',
            amount: -100,
            description: '无效',
            date: '2026-07-30',
          }],
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should reject invalid date format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{
            type: 'expense',
            amount: 1000,
            description: 'test',
            date: '2026/07/30',
          }],
        },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/transactions', () => {
    it('should list user transactions with pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions?page=1&page_size=10',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBeGreaterThanOrEqual(3)
      expect(body.data.total).toBeDefined()
      expect(body.data.page).toBe(1)
    })

    it('should filter by date range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions?start_date=2026-07-30&end_date=2026-07-30',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      body.data.items.forEach((t: any) => {
        expect(t.date).toBe('2026-07-30')
      })
    })

    it('should filter by type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions?type=income',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      body.data.items.forEach((t: any) => {
        expect(t.type).toBe('income')
      })
    })

    it('should enforce user isolation (user2 sees nothing)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions',
        headers: authHeaders(user2Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items).toHaveLength(0)
    })
  })

  describe('PUT /api/transactions/:id', () => {
    it('should update a transaction', async () => {
      // Get transaction ID first
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/transactions?page_size=1',
        headers: authHeaders(userToken),
      })
      const txId = JSON.parse(listRes.payload).data.items[0].id

      const res = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(userToken),
        payload: { description: '更新后的描述', amount: 5000 },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
    })

    it('should not allow user2 to update user1 transaction', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/transactions?page_size=1',
        headers: authHeaders(userToken),
      })
      const txId = JSON.parse(listRes.payload).data.items[0].id

      const res = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(user2Token),
        payload: { description: 'hacked' },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/transactions/:id (soft delete)', () => {
    it('should soft-delete a transaction', async () => {
      // Create one to delete
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{ client_id: '44444444-4444-4444-4444-444444444444', type: 'expense', amount: 999, description: '待删除', date: '2026-07-30' }],
        },
      })
      const txId = JSON.parse(createRes.payload).data.created[0].id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
    })

    it('should show deleted items in trash', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transactions/trash',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBeGreaterThanOrEqual(1)
    })

    it('should restore from trash', async () => {
      const trashRes = await app.inject({
        method: 'GET',
        url: '/api/transactions/trash',
        headers: authHeaders(userToken),
      })
      const trashId = JSON.parse(trashRes.payload).data.items[0].id

      const res = await app.inject({
        method: 'POST',
        url: `/api/transactions/${trashId}/restore`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
    })
  })
})
