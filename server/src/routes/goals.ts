/**
 * 财务目标路由 - /api/goals
 * 目标管理、进度追踪
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const createGoalSchema = z.object({
  name: z.string().min(1, '目标名称不能为空').max(100),
  type: z.enum(['saving', 'debt_payoff', 'investment', 'custom']),
  target_amount: z.number().int().positive('目标金额必须大于0'),
  current_amount: z.number().int().min(0).default(0),
  deadline: z.string().optional(),
  priority: z.number().int().min(1).max(10).default(5),
  linked_account_id: z.number().int().optional(),
  monthly_contribution: z.number().int().min(0).default(0),
  icon: z.string().max(10).default('🎯'),
  note: z.string().max(500).optional(),
})

const updateGoalSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(['saving', 'debt_payoff', 'investment', 'custom']).optional(),
  target_amount: z.number().int().positive().optional(),
  current_amount: z.number().int().min(0).optional(),
  deadline: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(10).optional(),
  linked_account_id: z.number().int().nullable().optional(),
  monthly_contribution: z.number().int().min(0).optional(),
  status: z.enum(['active', 'completed', 'paused', 'abandoned']).optional(),
  icon: z.string().max(10).optional(),
  note: z.string().max(500).nullable().optional(),
})

const progressSchema = z.object({
  amount: z.number().int().min(0, '进度金额不能为负'),
})

export async function goalsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/goals - 目标列表
  app.get('/api/goals', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { status?: string }
    const status = query.status || 'active'

    let sql = `SELECT * FROM financial_goals WHERE user_id = ?`
    const params: any[] = [userId]

    if (status !== 'all') {
      sql += ` AND status = ?`
      params.push(status)
    }
    sql += ` ORDER BY priority ASC, created_at DESC`

    const goals = db.prepare(sql).all(...params) as any[]

    // 计算每个目标的进度百分比
    const items = goals.map((g: any) => {
      const percent = g.target_amount > 0
        ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100))
        : 0
      const remaining = Math.max(0, g.target_amount - g.current_amount)

      // 计算预计完成时间
      let estimated_completion: string | null = null
      if (g.monthly_contribution > 0 && remaining > 0) {
        const monthsLeft = Math.ceil(remaining / g.monthly_contribution)
        const est = new Date()
        est.setMonth(est.getMonth() + monthsLeft)
        estimated_completion = est.toISOString().split('T')[0]
      }

      return { ...g, percent, remaining, estimated_completion }
    })

    return { code: 0, data: { items }, message: '' }
  })

  // POST /api/goals - 创建目标
  app.post('/api/goals', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createGoalSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 验证关联账户
      if (body.linked_account_id) {
        const acc = db.prepare(
          'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
        ).get(body.linked_account_id, userId)
        if (!acc) {
          reply.code(400)
          return { code: 2003, data: null, message: '关联账户不存在' }
        }
      }

      const now = new Date().toISOString()
      const result = db.prepare(
        `INSERT INTO financial_goals (user_id, name, type, target_amount, current_amount, deadline, priority, linked_account_id, monthly_contribution, icon, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId, body.name, body.type, body.target_amount, body.current_amount,
        body.deadline || null, body.priority, body.linked_account_id || null,
        body.monthly_contribution, body.icon, body.note || null, now, now
      )

      return {
        code: 0,
        data: { id: result.lastInsertRowid },
        message: '目标已创建',
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // PUT /api/goals/:id - 更新目标
  app.put('/api/goals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateGoalSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const updates: string[] = []
      const values: any[] = []

      if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name) }
      if (body.type !== undefined) { updates.push('type = ?'); values.push(body.type) }
      if (body.target_amount !== undefined) { updates.push('target_amount = ?'); values.push(body.target_amount) }
      if (body.current_amount !== undefined) { updates.push('current_amount = ?'); values.push(body.current_amount) }
      if (body.deadline !== undefined) { updates.push('deadline = ?'); values.push(body.deadline) }
      if (body.priority !== undefined) { updates.push('priority = ?'); values.push(body.priority) }
      if (body.linked_account_id !== undefined) { updates.push('linked_account_id = ?'); values.push(body.linked_account_id) }
      if (body.monthly_contribution !== undefined) { updates.push('monthly_contribution = ?'); values.push(body.monthly_contribution) }
      if (body.status !== undefined) { updates.push('status = ?'); values.push(body.status) }
      if (body.icon !== undefined) { updates.push('icon = ?'); values.push(body.icon) }
      if (body.note !== undefined) { updates.push('note = ?'); values.push(body.note) }

      if (updates.length === 0) {
        reply.code(400)
        return { code: 2000, data: null, message: '无更新字段' }
      }

      updates.push('updated_at = ?')
      values.push(new Date().toISOString())
      values.push(Number(id), userId)

      const result = db.prepare(
        `UPDATE financial_goals SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...values)

      if (result.changes === 0) {
        reply.code(404)
        return { code: 3002, data: null, message: '目标不存在' }
      }

      return { code: 0, data: null, message: '目标已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/goals/:id - 删除目标
  app.delete('/api/goals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db.prepare(
      'DELETE FROM financial_goals WHERE id = ? AND user_id = ?'
    ).run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '目标不存在' }
    }

    return { code: 0, data: null, message: '目标已删除' }
  })

  // POST /api/goals/:id/progress - 记录进度
  app.post('/api/goals/:id/progress', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = progressSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId
      const today = new Date().toISOString().split('T')[0]

      // 验证目标归属
      const goal = db.prepare(
        'SELECT id, target_amount FROM financial_goals WHERE id = ? AND user_id = ?'
      ).get(Number(id), userId) as { id: number; target_amount: number } | undefined

      if (!goal) {
        reply.code(404)
        return { code: 3002, data: null, message: '目标不存在' }
      }

      // 插入或更新今日进度快照
      db.prepare(
        `INSERT INTO goal_progress (goal_id, amount, snapshot_date)
         VALUES (?, ?, ?)
         ON CONFLICT(goal_id, snapshot_date)
         DO UPDATE SET amount = excluded.amount`
      ).run(goal.id, body.amount, today)

      // 同步更新目标的 current_amount
      db.prepare(
        'UPDATE financial_goals SET current_amount = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      ).run(body.amount, new Date().toISOString(), goal.id, userId)

      // 自动完成检测
      if (body.amount >= goal.target_amount) {
        db.prepare(
          'UPDATE financial_goals SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).run('completed', new Date().toISOString(), goal.id, userId)
      }

      return { code: 0, data: null, message: '进度已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // GET /api/goals/:id/progress - 进度历史
  app.get('/api/goals/:id/progress', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    // 验证目标归属
    const goal = db.prepare(
      'SELECT id FROM financial_goals WHERE id = ? AND user_id = ?'
    ).get(Number(id), userId)

    if (!goal) {
      reply.code(404)
      return { code: 3002, data: null, message: '目标不存在' }
    }

    const history = db.prepare(
      'SELECT amount, snapshot_date FROM goal_progress WHERE goal_id = ? ORDER BY snapshot_date'
    ).all(Number(id)) as Array<{ amount: number; snapshot_date: string }>

    return { code: 0, data: { history }, message: '' }
  })
}
