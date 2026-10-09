/**
 * AI 对话上下文测试
 *
 * 回归：历史消息取的是“最早 20 条”而非“最近 20 条”，
 * 对话超过 10 轮后模型完全看不到最近的上下文。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { loadRecentHistory } from '../../src/routes/ai.js'

describe('AI 对话上下文', () => {
  let app: FastifyInstance
  let token: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'chatuser')
    userId = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).payload,
    ).data.user.id
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  function seedSession(sessionId: string, count: number) {
    const db = getDb()
    const ins = db.prepare(
      'INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < count; i++) {
      ins.run(userId, sessionId, i % 2 === 0 ? 'user' : 'assistant', `msg-${String(i).padStart(2, '0')}`, '2026-09-01 00:00:00')
    }
  }

  it('应返回最近 N 条且按时间正序', () => {
    seedSession('sess-ctx-1', 25)
    const history = loadRecentHistory(getDb(), userId, 'sess-ctx-1', 20)

    expect(history).toHaveLength(20)
    // 第一条应是第 5 条（25 - 20），最后一条应是第 24 条
    expect(history[0]!.content).toBe('msg-05')
    expect(history[history.length - 1]!.content).toBe('msg-24')
    // 正序
    expect(history.map((h) => h.content)).toEqual([...history.map((h) => h.content)].sort())
    // role 与位置对应：msg-05 是奇数索引 → assistant
    expect(history[0]!.role).toBe('assistant')
    expect(history[1]!.role).toBe('user')
  })

  it('不足 N 条时返回全部', () => {
    seedSession('sess-ctx-2', 3)
    const history = loadRecentHistory(getDb(), userId, 'sess-ctx-2', 20)
    expect(history.map((h) => h.content)).toEqual(['msg-00', 'msg-01', 'msg-02'])
  })

  it('不同 session 互不串味', () => {
    const a = loadRecentHistory(getDb(), userId, 'sess-ctx-1', 20)
    const b = loadRecentHistory(getDb(), userId, 'sess-ctx-2', 20)
    expect(a).not.toEqual(b)
    expect(b.every((h) => ['msg-00', 'msg-01', 'msg-02'].includes(h.content))).toBe(true)
  })

  it('不返回 system 角色的记录', () => {
    getDb()
      .prepare('INSERT INTO ai_conversations (user_id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(userId, 'sess-ctx-3', 'system', 'should-not-appear')
    const history = loadRecentHistory(getDb(), userId, 'sess-ctx-3', 20)
    expect(history.some((h) => h.content === 'should-not-appear')).toBe(false)
  })

  describe('GET /api/ai/sessions', () => {
    it('first_message 应是时间最早的那条，而非字典序最小的', async () => {
      // "zzz" 字典序 < "aaa"，但它在时间上更晚
      const db = getDb()
      db.prepare('INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, 'sess-order', 'user', 'zzz-first-in-time', '2026-09-01 00:00:00')
      db.prepare('INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, 'sess-order', 'user', 'aaa-later-in-time', '2026-09-02 00:00:00')

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/sessions',
        headers: authHeaders(token),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      const session = body.data.items.find((s: any) => s.session_id === 'sess-order')
      expect(session).toBeDefined()
      expect(session.first_message).toBe('zzz-first-in-time')
      expect(session.message_count).toBe(2)
      expect(session.last_at).toBe('2026-09-02 00:00:00')
    })
  })
})
