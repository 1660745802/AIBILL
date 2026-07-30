/**
 * 订阅管理路由 - /api/subscriptions
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const createSubscriptionSchema = z.object({
  name: z.string().min(1).max(100),
  amount: z.number().int().positive('金额必须大于0'),
  cycle: z.enum(['monthly', 'quarterly', 'yearly']),
  category_id: z.number().int().positive().optional(),
  account_id: z.number().int().positive().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD'),
  reminder_days: z.number().int().min(0).max(30).default(3),
  auto_record: z.boolean().default(false),
  note: z.string().max(500).optional(),
})

const updateSubscriptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  amount: z.number().int().positive('金额必须大于0').optional(),
  cycle: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  category_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD').optional(),
  reminder_days: z.number().int().min(0).max(30).optional(),
  auto_record: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
})

/**
 * 计算下一次付款日期
 * 从 startDate 开始按 cycle 累加，直到超过当前时间
 */
function calcNextPayment(startDate: string, cycle: 'monthly' | 'quarterly' | 'yearly'): string {
  const start = new Date(startDate)
  if (isNaN(start.getTime())) {
    // Fallback: use today as start if date is invalid
    return new Date().toISOString().slice(0, 10)
  }
  const now = new Date()
  const months = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 12

  let next = new Date(start)
  let iterations = 0
  while (next <= now && iterations < 10000) {
    next.setMonth(next.getMonth() + months)
    iterations++
  }
  return next.toISOString().slice(0, 10)
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/subscriptions - 获取订阅列表
  app.get('/api/subscriptions', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { status?: string }
    const statusFilter = query.status || 'active'

    let whereClause: string
    if (statusFilter === 'all') {
      whereClause = 's.user_id = ?'
    } else {
      whereClause = 's.user_id = ? AND s.status = ?'
    }

    const params: any[] = statusFilter === 'all' ? [userId] : [userId, statusFilter]

    const items = db
      .prepare(
        `SELECT s.*, c.name as category_name, a.name as account_name
         FROM subscriptions s
         LEFT JOIN categories c ON s.category_id = c.id
         LEFT JOIN accounts a ON s.account_id = a.id
         WHERE ${whereClause}
         ORDER BY s.created_at DESC`,
      )
      .all(...params) as any[]

    // 计算月度/年度总额（仅 active 订阅）
    const activeItems = db
      .prepare(
        `SELECT amount, cycle FROM subscriptions
         WHERE user_id = ? AND status = 'active'`,
      )
      .all(userId) as Array<{ amount: number; cycle: string }>

    let monthlyTotal = 0
    let yearlyTotal = 0
    for (const item of activeItems) {
      if (item.cycle === 'monthly') {
        monthlyTotal += item.amount
        yearlyTotal += item.amount * 12
      } else if (item.cycle === 'quarterly') {
        monthlyTotal += Math.round(item.amount / 3)
        yearlyTotal += item.amount * 4
      } else if (item.cycle === 'yearly') {
        monthlyTotal += Math.round(item.amount / 12)
        yearlyTotal += item.amount
      }
    }

    // 即将到期的订阅（7天内）
    const now = new Date()
    const sevenDaysLater = new Date(now)
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7)
    const todayStr = now.toISOString().slice(0, 10)
    const sevenDaysStr = sevenDaysLater.toISOString().slice(0, 10)

    const upcoming = db
      .prepare(
        `SELECT s.*, c.name as category_name, a.name as account_name
         FROM subscriptions s
         LEFT JOIN categories c ON s.category_id = c.id
         LEFT JOIN accounts a ON s.account_id = a.id
         WHERE s.user_id = ? AND s.status = 'active'
           AND s.next_payment_date BETWEEN ? AND ?
         ORDER BY s.next_payment_date ASC`,
      )
      .all(userId, todayStr, sevenDaysStr) as any[]

    return {
      code: 0,
      data: { items, monthly_total: monthlyTotal, yearly_total: yearlyTotal, upcoming },
      message: '',
    }
  })

  // POST /api/subscriptions - 创建订阅
  app.post('/api/subscriptions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createSubscriptionSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 校验 category_id 归属
      if (body.category_id) {
        const cat = db
          .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
          .get(body.category_id, userId)
        if (!cat) {
          reply.code(400)
          return { code: 2003, data: null, message: '分类不存在' }
        }
      }

      // 校验 account_id 归属
      if (body.account_id) {
        const acc = db
          .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
          .get(body.account_id, userId)
        if (!acc) {
          reply.code(400)
          return { code: 2004, data: null, message: '账户不存在' }
        }
      }

      const nextPaymentDate = calcNextPayment(body.start_date, body.cycle)

      const result = db
        .prepare(
          `INSERT INTO subscriptions (user_id, name, amount, cycle, category_id, account_id, start_date, next_payment_date, reminder_days, auto_record, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          body.name,
          body.amount,
          body.cycle,
          body.category_id || null,
          body.account_id || null,
          body.start_date,
          nextPaymentDate,
          body.reminder_days,
          body.auto_record ? 1 : 0,
          body.note || null,
        )

      const subscription = db
        .prepare('SELECT * FROM subscriptions WHERE id = ?')
        .get(result.lastInsertRowid) as any

      return { code: 0, data: subscription, message: '订阅已创建' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // PUT /api/subscriptions/:id - 更新订阅
  app.put('/api/subscriptions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateSubscriptionSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 验证所有权
      const existing = db
        .prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?')
        .get(Number(id), userId) as any

      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '订阅不存在' }
      }

      // 构建更新字段
      const updates: string[] = []
      const values: any[] = []

      if (body.name !== undefined) {
        updates.push('name = ?')
        values.push(body.name)
      }
      if (body.amount !== undefined) {
        updates.push('amount = ?')
        values.push(body.amount)
      }
      if (body.cycle !== undefined) {
        updates.push('cycle = ?')
        values.push(body.cycle)
      }
      if (body.category_id !== undefined) {
        if (body.category_id !== null) {
          const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(body.category_id, userId)
          if (!cat) {
            reply.code(400)
            return { code: 2003, data: null, message: '分类不存在' }
          }
        }
        updates.push('category_id = ?')
        values.push(body.category_id)
      }
      if (body.account_id !== undefined) {
        if (body.account_id !== null) {
          const acc = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(body.account_id, userId)
          if (!acc) {
            reply.code(400)
            return { code: 2004, data: null, message: '账户不存在' }
          }
        }
        updates.push('account_id = ?')
        values.push(body.account_id)
      }
      if (body.start_date !== undefined) {
        updates.push('start_date = ?')
        values.push(body.start_date)
      }
      if (body.reminder_days !== undefined) {
        updates.push('reminder_days = ?')
        values.push(body.reminder_days)
      }
      if (body.auto_record !== undefined) {
        updates.push('auto_record = ?')
        values.push(body.auto_record ? 1 : 0)
      }
      if (body.note !== undefined) {
        updates.push('note = ?')
        values.push(body.note)
      }

      // 如果 start_date 或 cycle 变化，重新计算 next_payment_date
      const newStartDate = body.start_date || existing.start_date
      const newCycle = body.cycle || existing.cycle
      if (body.start_date !== undefined || body.cycle !== undefined) {
        const nextPaymentDate = calcNextPayment(newStartDate, newCycle)
        updates.push('next_payment_date = ?')
        values.push(nextPaymentDate)
      }

      if (updates.length === 0) {
        return { code: 0, data: existing, message: '无需更新' }
      }

      updates.push("updated_at = datetime('now')")
      values.push(Number(id), userId)

      db.prepare(
        `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      ).run(...values)

      const updated = db
        .prepare('SELECT * FROM subscriptions WHERE id = ?')
        .get(Number(id)) as any

      return { code: 0, data: updated, message: '订阅已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/subscriptions/:id - 删除订阅
  app.delete('/api/subscriptions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?')
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '订阅不存在' }
    }

    return { code: 0, data: null, message: '订阅已删除' }
  })

  // POST /api/subscriptions/:id/cancel - 取消订阅
  app.post('/api/subscriptions/:id/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      )
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '订阅不存在' }
    }

    return { code: 0, data: null, message: '订阅已取消' }
  })

  // POST /api/subscriptions/:id/renew - 续订
  app.post('/api/subscriptions/:id/renew', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    // 获取订阅信息
    const existing = db
      .prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?')
      .get(Number(id), userId) as any

    if (!existing) {
      reply.code(404)
      return { code: 3002, data: null, message: '订阅不存在' }
    }

    // 从今天开始重新计算 next_payment_date
    const today = new Date().toISOString().slice(0, 10)
    const nextPaymentDate = calcNextPayment(today, existing.cycle)

    db.prepare(
      `UPDATE subscriptions SET status = 'active', next_payment_date = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).run(nextPaymentDate, Number(id), userId)

    const updated = db
      .prepare('SELECT * FROM subscriptions WHERE id = ?')
      .get(Number(id)) as any

    return { code: 0, data: updated, message: '订阅已续订' }
  })
}
