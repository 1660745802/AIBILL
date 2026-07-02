/**
 * 统计路由 - /api/stats
 * GET /api/stats/summary - 月度收支摘要
 * GET /api/stats/by-category - 分类排行
 * GET /api/stats/trend - 日/月趋势
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/stats/summary - 月度收支摘要
  app.get('/api/stats/summary', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string }

    const now = new Date()
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    // 当月收支
    const result = db
      .prepare(
        `SELECT type, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, startDate, endDate) as Array<{ type: string; total: number; count: number }>

    let expense = 0, income = 0, expenseCount = 0, incomeCount = 0
    for (const row of result) {
      if (row.type === 'expense') { expense = row.total; expenseCount = row.count }
      if (row.type === 'income') { income = row.total; incomeCount = row.count }
    }

    // 上月数据（计算环比）
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    const prevStartDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
    const prevLastDay = new Date(prevYear, prevMonth, 0).getDate()
    const prevEndDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`

    const prevResult = db
      .prepare(
        `SELECT type, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, prevStartDate, prevEndDate) as Array<{ type: string; total: number }>

    let prevExpense = 0, prevIncome = 0
    for (const row of prevResult) {
      if (row.type === 'expense') prevExpense = row.total
      if (row.type === 'income') prevIncome = row.total
    }

    return {
      code: 0,
      data: {
        year,
        month,
        expense,
        income,
        balance: income - expense,
        expense_count: expenseCount,
        income_count: incomeCount,
        prev_expense: prevExpense,
        prev_income: prevIncome,
        expense_change: prevExpense ? Math.round(((expense - prevExpense) / prevExpense) * 100) : null,
        income_change: prevIncome ? Math.round(((income - prevIncome) / prevIncome) * 100) : null,
      },
      message: '',
    }
  })

  // GET /api/stats/by-category - 分类排行
  app.get('/api/stats/by-category', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string; type?: string }

    const now = new Date()
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)
    const type = query.type || 'expense'

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.icon, SUM(t.amount) as total, COUNT(*) as count
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
           AND t.type = ?
           AND t.date BETWEEN ? AND ?
         GROUP BY t.category_id
         ORDER BY total DESC`,
      )
      .all(userId, type, startDate, endDate) as Array<{
      id: number
      name: string
      icon: string
      total: number
      count: number
    }>

    // 计算总额和占比
    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0)
    const items = rows.map((r) => ({
      ...r,
      percent: grandTotal ? Math.round((r.total / grandTotal) * 1000) / 10 : 0,
    }))

    return {
      code: 0,
      data: { items, total: grandTotal, year, month, type },
      message: '',
    }
  })

  // GET /api/stats/trend - 日/月趋势
  app.get('/api/stats/trend', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as {
      year?: string
      month?: string
      period?: string // 'daily' | 'monthly'
      type?: string
    }

    const now = new Date()
    const type = query.type || 'expense'
    const period = query.period || 'daily'

    if (period === 'monthly') {
      // 月度趋势：最近12个月
      const year = parseInt(query.year || String(now.getFullYear()), 10)

      const rows = db
        .prepare(
          `SELECT
            substr(date, 1, 7) as month,
            SUM(amount) as total,
            COUNT(*) as count
           FROM transactions
           WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
             AND type = ?
             AND date >= ?
           GROUP BY substr(date, 1, 7)
           ORDER BY month ASC`,
        )
        .all(
          userId,
          type,
          `${year - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        ) as Array<{ month: string; total: number; count: number }>

      return { code: 0, data: { items: rows, period, type }, message: '' }
    }

    // 日趋势：指定月份每日数据
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const rows = db
      .prepare(
        `SELECT date, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type = ?
           AND date BETWEEN ? AND ?
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(userId, type, startDate, endDate) as Array<{ date: string; total: number; count: number }>

    // 补全空白日期
    const filled: Array<{ date: string; total: number; count: number }> = []
    const dataMap = new Map(rows.map((r) => [r.date, r]))
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      filled.push(dataMap.get(dateStr) || { date: dateStr, total: 0, count: 0 })
    }

    return { code: 0, data: { items: filled, period, type, year, month }, message: '' }
  })
}
