/**
 * 财务目标路由集成测试
 *
 * 覆盖两件事（都是「写一半就留下半状态」的防线）：
 *   1. 金额字段拒绝非安全整数（SQLite 的 INTEGER 列会把 1e20 存成 REAL）
 *   2. 进度三写（goal_progress 快照 + current_amount + 自动 completed）同事务
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('Goal Routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'goaluser')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  async function createGoal(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/goals',
      headers: authHeaders(token),
      payload: { name: '旅行基金', type: 'saving', target_amount: 1000000, ...payload },
    })
  }

  /** 按名字取 id（不靠列表顺序，避免同毫秒创建时顺序不定） */
  const goalId = async (name: string): Promise<number> => {
    const res = await app.inject({ method: 'GET', url: '/api/goals?status=all', headers: authHeaders(token) })
    const found = JSON.parse(res.payload).data.items.find((g: { name: string }) => g.name === name)
    if (!found) throw new Error(`找不到目标 ${name}`)
    return found.id
  }

  describe('关联账户的创建/更新隔离', () => {
    it('他人/不存在/停用账户均拒绝且不泄露存在性；失败不能改动目标', async () => {
      const db = getDb()
      const owner = db.prepare('SELECT id FROM users WHERE username = ?').get('goaluser') as { id: number }
      const otherId = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('goal_other', 'x')").run().lastInsertRowid)
      const account = (userId: number, name: string, active = 1) => Number(db.prepare(
        'INSERT INTO accounts (user_id, name, is_active) VALUES (?, ?, ?)',
      ).run(userId, name, active).lastInsertRowid)
      const ownId = account(owner.id, '目标账户')
      const otherAccount = account(otherId, '他人账户')
      const inactiveId = account(owner.id, '停用账户', 0)
      const created = await createGoal({ name: '账户归属', linked_account_id: ownId })
      expect(created.statusCode).toBe(200)
      const id = created.json().data.id
      const before = db.prepare('SELECT * FROM financial_goals WHERE id = ?').get(id)
      const beforeAll = db.prepare('SELECT * FROM financial_goals ORDER BY id').all()
      const otherBefore = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(otherId)
      for (const linked_account_id of [otherAccount, 999999, inactiveId]) {
        const create = await createGoal({ linked_account_id })
        const update = await app.inject({
          method: 'PUT', url: `/api/goals/${id}`, headers: authHeaders(token),
          payload: { linked_account_id, name: '不应写入' },
        })
        for (const res of [create, update]) {
          expect(res.statusCode).toBe(400)
          expect(res.json()).toEqual({ code: 2003, data: null, message: '关联账户不存在' })
        }
        expect(db.prepare('SELECT * FROM financial_goals WHERE id = ?').get(id)).toEqual(before)
        expect(db.prepare('SELECT * FROM financial_goals ORDER BY id').all()).toEqual(beforeAll)
      }
      for (const linked_account_id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await createGoal({ linked_account_id })).statusCode).toBe(400)
        expect((await app.inject({
          method: 'PUT', url: `/api/goals/${id}`, headers: authHeaders(token), payload: { linked_account_id },
        })).statusCode).toBe(400)
      }
      expect(db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(otherId)).toEqual(otherBefore)

      // 合法关联可更新；null 解除关联；不带该字段可继续编辑（即使原账户后来停用）。
      const nextId = account(owner.id, '新的目标账户')
      for (const linked_account_id of [nextId, null, ownId]) {
        const res = await app.inject({
          method: 'PUT', url: `/api/goals/${id}`, headers: authHeaders(token), payload: { linked_account_id },
        })
        expect(res.statusCode).toBe(200)
        expect(db.prepare('SELECT linked_account_id FROM financial_goals WHERE id = ?').get(id)).toEqual({ linked_account_id })
      }
      db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(ownId)
      expect((await app.inject({
        method: 'PUT', url: `/api/goals/${id}`, headers: authHeaders(token), payload: { name: '仍可编辑' },
      })).statusCode).toBe(200)
      expect((await createGoal()).statusCode).toBe(200)
    })
  })

  describe('金额字段', () => {
    it('非安全整数应被拒（target_amount / current_amount / monthly_contribution）', async () => {
      for (const payload of [
        { target_amount: 1e20 },
        { current_amount: 1e20 },
        { monthly_contribution: 1e20 },
      ]) {
        const res = await createGoal(payload)
        expect(res.statusCode, JSON.stringify(payload)).toBe(400)
        expect(JSON.parse(res.payload).code).toBe(2000)
      }
      // 进度金额同理
      await createGoal({ name: '进度金额' })
      const id = await goalId('进度金额')
      const res = await app.inject({
        method: 'POST',
        url: `/api/goals/${id}/progress`,
        headers: authHeaders(token),
        payload: { amount: 1e20 },
      })
      expect(res.statusCode).toBe(400)
    })

    it('正常金额仍可用', async () => {
      const res = await createGoal({ monthly_contribution: 50000 })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('进度三写的原子性', () => {
    it('任一步失败时不留半状态：goal_progress 快照必须跟着回滚', async () => {
      await createGoal({ name: '原子性', target_amount: 500000 })
      const id = await goalId('原子性')
      const db = getDb()

      // 让第二步（更新 financial_goals.current_amount）必定失败 —— 模拟「中途出错」
      db.exec("CREATE TRIGGER boom BEFORE UPDATE ON financial_goals BEGIN SELECT RAISE(ABORT, 'boom'); END;")
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/goals/${id}/progress`,
          headers: authHeaders(token),
          payload: { amount: 12345 },
        })
        // 触发器抛错 → 500（全局错误出口），但关键是**不能留下半状态**
        expect(res.statusCode).toBeGreaterThanOrEqual(500)

        const progress = db
          .prepare('SELECT count(*) c FROM goal_progress WHERE goal_id = ?')
          .get(id) as { c: number }
        expect(progress.c).toBe(0)                       // 快照被回滚
        const goal = db
          .prepare('SELECT current_amount FROM financial_goals WHERE id = ?')
          .get(id) as { current_amount: number }
        expect(goal.current_amount).toBe(0)               // 金额也没变
      } finally {
        db.exec('DROP TRIGGER IF EXISTS boom')
      }
    })

    it('成功时三写都生效（快照 / current_amount / 达标自动 completed）', async () => {
      await createGoal({ name: '正常进度', target_amount: 500000 })
      const id = await goalId('正常进度')
      const res = await app.inject({
        method: 'POST',
        url: `/api/goals/${id}/progress`,
        headers: authHeaders(token),
        payload: { amount: 500000 },
      })
      expect(res.statusCode).toBe(200)

      const db = getDb()
      expect(db.prepare('SELECT count(*) c FROM goal_progress WHERE goal_id = ?').get(id)).toEqual({ c: 1 })
      const goal = db
        .prepare('SELECT current_amount, status FROM financial_goals WHERE id = ?')
        .get(id) as { current_amount: number; status: string }
      expect(goal.current_amount).toBe(500000)
      expect(goal.status).toBe('completed')
    })
  })
})
