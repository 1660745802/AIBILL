/**
 * 预算路由 - /api/budgets
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const createBudgetSchema = z.object({
  category_id: z.number().int().min(0).default(0), // 0=总预算
  amount: z.number().int().positive('预算金额必须大于0'),
  period: z.enum(['monthly', 'yearly']).default('monthly'),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(0).max(12).default(0), // 0=全年
})

const updateBudgetSchema = z.object({
  amount: z.number().int().positive('预算金额必须大于0'),
})

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/budgets - 获取预算列表（含使用情况）
  app.get('/api/budgets', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string }

    const now = new Date()
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    // 获取当月所有预算
    const budgets = db
      .prepare(
        `SELECT b.*, c.name as category_name, c.icon as category_icon
         FROM budgets b
         LEFT JOIN categories c ON b.category_id = c.id AND b.category_id != 0
         WHERE b.user_id = ? AND b.year = ? AND (b.month = ? OR b.month = 0)
         ORDER BY b.category_id`,
      )
      .all(userId, year, month) as any[]

    // 计算每个预算的已用金额
    const items = budgets.map((b: any) => {
      let spent: number

      if (b.category_id === 0) {
        // 总预算：所有支出
        const result = db
          .prepare(
            `SELECT COALESCE(SUM(amount), 0) as total
             FROM transactions
             WHERE user_id = ? AND type = 'expense'
               AND status = 'confirmed' AND deleted_at IS NULL
               AND date BETWEEN ? AND ?`,
          )
          .get(userId, startDate, endDate) as { total: number }
        spent = result.total
      } else {
        // 分类预算
        const result = db
          .prepare(
            `SELECT COALESCE(SUM(amount), 0) as total
             FROM transactions
             WHERE user_id = ? AND type = 'expense'
               AND category_id = ?
               AND status = 'confirmed' AND deleted_at IS NULL
               AND date BETWEEN ? AND ?`,
          )
          .get(userId, b.category_id, startDate, endDate) as { total: number }
        spent = result.total
      }

      const percent = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0
      let status: 'normal' | 'warning' | 'exceeded'
      if (percent >= 100) status = 'exceeded'
      else if (percent >= 80) status = 'warning'
      else status = 'normal'

      return {
        ...b,
        category_name: b.category_id === 0 ? '总预算' : (b.category_name || '未知'),
        category_icon: b.category_id === 0 ? '💰' : (b.category_icon || '📦'),
        spent,
        percent,
        status,
        remaining: Math.max(0, b.amount - spent),
      }
    })

    return { code: 0, data: { items, year, month }, message: '' }
  })

  // POST /api/budgets - 设置预算
  app.post('/api/budgets', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createBudgetSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 校验 category_id 归属（非总预算时）
      if (body.category_id > 0) {
        const cat = db
          .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ? AND is_active = 1')
          .get(body.category_id, userId)
        if (!cat) {
          reply.code(400)
          return { code: 2003, data: null, message: '分类不存在' }
        }
      }

      // UPSERT：同一用户+分类+年月只能有一条
      db.prepare(
        `INSERT INTO budgets (user_id, category_id, amount, period, year, month)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, category_id, year, month)
         DO UPDATE SET amount = excluded.amount, period = excluded.period`,
      ).run(userId, body.category_id, body.amount, body.period, body.year, body.month)

      return { code: 0, data: null, message: '预算已设置' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // PUT /api/budgets/:id - 修改预算金额
  app.put('/api/budgets/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateBudgetSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const result = db
        .prepare('UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?')
        .run(body.amount, Number(id), userId)

      if (result.changes === 0) {
        reply.code(404)
        return { code: 3002, data: null, message: '预算不存在' }
      }

      return { code: 0, data: null, message: '预算已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/budgets/:id - 删除预算
  app.delete('/api/budgets/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?')
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '预算不存在' }
    }

    return { code: 0, data: null, message: '预算已删除' }
  })
}
