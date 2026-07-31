/**
 * 记忆路由集成测试
 * 覆盖: CRUD、用户隔离、AI parse 集成
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('Memory Routes', () => {
  let app: FastifyInstance
  let user1Token: string
  let user2Token: string
  let memoryId: number

  beforeAll(async () => {
    app = await buildApp()
    user1Token = await createUser(app, 'memoryuser1')
    user2Token = await createUser(app, 'memoryuser2')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/memories', () => {
    it('should create a memory with default category', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user1Token),
        payload: { content: '午饭一般在公司食堂吃，大约20元' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.content).toBe('午饭一般在公司食堂吃，大约20元')
      expect(body.data.category).toBe('preference')
      expect(body.data.source).toBe('manual')
      expect(body.data.is_active).toBe(1)
      memoryId = body.data.id
    })

    it('should create a memory with specified category', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user1Token),
        payload: { content: '每月房租3000元', category: 'rule' },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.category).toBe('rule')
    })

    it('should reject empty content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user1Token),
        payload: { content: '' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should reject content exceeding 500 chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user1Token),
        payload: { content: 'a'.repeat(501) },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/memories', () => {
    it('should list all memories for user1', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: authHeaders(user1Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBe(2)
      // ordered by created_at DESC - both created in same second, verify categories exist
      const categories = body.data.items.map((i: any) => i.category).sort()
      expect(categories).toEqual(['preference', 'rule'])
    })

    it('should return empty list for user2', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: authHeaders(user2Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBe(0)
    })
  })

  describe('PUT /api/memories/:id', () => {
    it('should update content', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memories/${memoryId}`,
        headers: authHeaders(user1Token),
        payload: { content: '午饭一般在食堂吃，大约25元' },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.content).toBe('午饭一般在食堂吃，大约25元')
    })

    it('should update is_active to 0', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memories/${memoryId}`,
        headers: authHeaders(user1Token),
        payload: { is_active: 0 },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.is_active).toBe(0)
    })

    it('should not allow user2 to update user1 memory', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memories/${memoryId}`,
        headers: authHeaders(user2Token),
        payload: { content: 'hacked' },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/memories/:id', () => {
    it('should not allow user2 to delete user1 memory', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}`,
        headers: authHeaders(user2Token),
      })
      expect(res.statusCode).toBe(404)
    })

    it('should delete memory', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}`,
        headers: authHeaders(user1Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)

      // verify deleted
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: authHeaders(user1Token),
      })
      const listBody = JSON.parse(listRes.payload)
      expect(listBody.data.items.length).toBe(1) // only the 'rule' one remains
    })
  })

  describe('User isolation', () => {
    it('user2 cannot see user1 memories', async () => {
      // user2 creates their own memory
      await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user2Token),
        payload: { content: 'user2 的偏好' },
      })

      const res1 = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: authHeaders(user1Token),
      })
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/memories',
        headers: authHeaders(user2Token),
      })

      const items1 = JSON.parse(res1.payload).data.items
      const items2 = JSON.parse(res2.payload).data.items

      // user1 has 1 remaining, user2 has 1
      expect(items1.length).toBe(1)
      expect(items2.length).toBe(1)
      expect(items1[0].content).not.toBe(items2[0].content)
    })
  })

  describe('AI parse with memories', () => {
    it('simple input should be handled by quick parser', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/parse',
        headers: authHeaders(user1Token),
        payload: { input: '午饭32' },
      })
      const body = JSON.parse(res.payload)
      // Quick parser handles simple input successfully
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.source).toBe('quick')
      expect(body.data.items[0].description).toBe('午饭')
    })

    it('complex input should fail without AI key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/parse',
        headers: authHeaders(user1Token),
        payload: { input: '昨天在星巴克请朋友喝了两杯拿铁，用信用卡付的' },
      })
      const body = JSON.parse(res.payload)
      // Complex input goes to AI, which fails without key
      expect([502, 504, 200]).toContain(res.statusCode)
      expect(body.code).not.toBe(0)
    })

    it('memories are stored in DB and queryable', async () => {
      // Create a memory for user1
      await app.inject({
        method: 'POST',
        url: '/api/memories',
        headers: authHeaders(user1Token),
        payload: { content: '默认用微信支付' },
      })

      // Verify it's queryable from DB directly (integration verification)
      const { getDb } = await import('../../src/db/index.js')
      const db = getDb()
      const userId = JSON.parse(
        Buffer.from(user1Token.split('.')[1], 'base64').toString(),
      ).userId

      const memories = db
        .prepare(
          'SELECT content FROM ai_memories WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 20',
        )
        .all(userId) as Array<{ content: string }>

      expect(memories.length).toBeGreaterThanOrEqual(1)
      expect(memories.some((m) => m.content === '默认用微信支付')).toBe(true)
    })
  })
})
