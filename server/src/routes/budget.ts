/**
 * 预算路由 - /api/budgets
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { monthRange, beijingYearMonth, today } from '../lib/date.js'
import { budgetProgress } from '../lib/budget.js'

const createBudgetSchema = z.object({
  category_id: z.number().int().min(0).default(0), // 0=总预算
  // `.safe()`：`int().positive()` 放过 1e20，而 SQLite 的 INTEGER 列会把它存成 REAL
  // （实测 typeof='real'）——预算是「整数分」，浮点会让 percent/remaining 跟着飘
  amount: z.number().int().positive('预算金额必须大于0').safe(),
  period: z.enum(['monthly', 'yearly']).default('monthly'),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(0).max(12).default(0), // 0=全年
})

const updateBudgetSchema = z.object({
  amount: z.number().int().positive('预算金额必须大于0').safe(),
})

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/budgets - 获取预算列表（含使用情况）
  app.get('/api/budgets', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string }

    const bj = beijingYearMonth()
    const year = parseInt(query.year || String(bj.year), 10)
    const month = parseInt(query.month || String(bj.month), 10)

    const { start: startDate, end: endDate } = monthRange(year, month)

    // 全年预算（`month=0`）的 spent 要按**全年区间**统计：请求月份那一个月的
    // 区间会把全年进度算成当月进度。取「年初 → 今天」（北京时间，lib/date.ts），
    // 因为进度回答的是「今年到目前为止用了多少」；请求往年则统计整年。
    const yearStart = `${year}-01-01`
    const yearSpentEnd = year === bj.year ? today() : `${year}-12-31`

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

    // 预取支出（每条预算再查一次就是 N+1）：月度区间一份、年度区间一份
    const sumByCategory = (from: string, to: string) => {
      const rows = db
        .prepare(
          `SELECT category_id, SUM(amount) as total FROM transactions
           WHERE user_id = ? AND type = 'expense' AND status = 'confirmed' AND deleted_at IS NULL
             AND date BETWEEN ? AND ?
           GROUP BY category_id`,
        )
        .all(userId, from, to) as Array<{ category_id: number; total: number }>
      const byCat = new Map<number, number>()
      let total = 0
      for (const r of rows) {
        byCat.set(r.category_id, r.total)
        total += r.total
      }
      return { byCat, total }
    }
    const emptyBucket = { byCat: new Map<number, number>(), total: 0 }
    const monthSpent = budgets.length > 0 ? sumByCategory(startDate, endDate) : emptyBucket
    const yearSpent = budgets.some((b: any) => b.month === 0)
      ? sumByCategory(yearStart, yearSpentEnd)
      : emptyBucket

      // 计算每个预算的已用金额
      const items = budgets.map((b: any) => {
        // 年度预算走年度区间，月度预算走请求月份区间；category_id=0 是「总预算」聚合
        const bucket = b.month === 0 ? yearSpent : monthSpent
        const spent = b.category_id === 0 ? bucket.total : (bucket.byCat.get(b.category_id) || 0)
        const { percent, status, remaining } = budgetProgress(spent, b.amount)

        return {
          ...b,
          category_name: b.category_id === 0 ? '总预算' : (b.category_name || '未知'),
          category_icon: b.category_id === 0 ? '💰' : (b.category_icon || '📦'),
          spent,
          percent,
          status,
          remaining,
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
