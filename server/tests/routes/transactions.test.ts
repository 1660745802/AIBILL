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

  describe('PUT /api/transactions/:id 的字段归属与类型一致性', () => {
    /** 建一笔无归属支出，返回 id */
    async function mkTx(desc: string): Promise<number> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: { items: [{ type: 'expense', amount: 1234, date: '2026-07-30', description: desc }] },
      })
      return JSON.parse(res.payload).data.created[0].id
    }

    it('把账单改到别人的分类上应被拒绝（POST 校验了、PUT 漏了）', async () => {
      const txId = await mkTx('跨用户分类')
      const otherCats = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(user2Token) })).payload,
      ).data.items as Array<{ id: number; name: string; type: string }>
      const otherCat = otherCats.find((c) => c.type === 'expense')!

      const res = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(userToken),
        payload: { category_id: otherCat.id },
      })
      expect(res.statusCode).toBe(400)

      // 而且不能真的写进去（写进去以后列表/统计会 JOIN 出别人的分类名）
      const detail = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/transactions/${txId}`, headers: authHeaders(userToken) })).payload,
      ).data
      expect(detail.category_id).toBeNull()
      expect(detail.category_name).toBeNull()
    })

    it('把类型改成 transfer 却没给目标账户应被拒绝（否则源账户扣钱、对方不增，净资产凭空减少）', async () => {
      const txId = await mkTx('无目标账户的转账')
      const res = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(userToken),
        payload: { type: 'transfer' },
      })
      expect(res.statusCode).toBe(400)
      const detail = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/transactions/${txId}`, headers: authHeaders(userToken) })).payload,
      ).data
      expect(detail.type).toBe('expense')
    })

    it('只改金额不重传 target_account_id 时不应误伤已有的转账', async () => {
      const mkAcc = async (name: string): Promise<number> => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: authHeaders(userToken),
          payload: { name, type: 'cash', initial_balance: 0 },
        })
        return JSON.parse(res.payload).data.id as number
      }
      const accA = await mkAcc('测试账户A')
      const accB = await mkAcc('测试账户B')

      const created = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: {
          items: [{ type: 'transfer', amount: 5000, date: '2026-07-30', account_id: accA, target_account_id: accB, description: '转账' }],
        },
      })
      expect(created.statusCode).toBe(200)
      const txId = JSON.parse(created.payload).data.created[0].id

      const res = await app.inject({
        method: 'PUT',
        url: `/api/transactions/${txId}`,
        headers: authHeaders(userToken),
        payload: { amount: 6000 },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).data.target_account_id).toBe(accB)
    })

    it('page/page_size 传非数字不应 500（NaN 会绑进 LIMIT/OFFSET）', async () => {
      for (const url of ['/api/transactions?page=abc&page_size=xyz', '/api/transactions/trash?page=abc']) {
        const res = await app.inject({ method: 'GET', url, headers: authHeaders(userToken) })
        expect(res.statusCode, url).toBe(200)
        expect(JSON.parse(res.payload).data.page).toBe(1)
      }
    })

    it('非安全整数金额应被拒绝（否则 SQLite 把 INTEGER 列存成 REAL）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(userToken),
        payload: { items: [{ type: 'expense', amount: 1e20, date: '2026-07-30', description: '溢出' }] },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).code).toBe(2000)
    })
  })
})
