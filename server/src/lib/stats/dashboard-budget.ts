/**
 * 仪表盘 · §4 当月分类支出 Top5 + §5 预算进度
 *
 * 预算进度是**先按月/全年两个区间各做一次批量聚合**再配对（避免 N+1）；
 * `budget_progress` 交给 `dashboard-alerts.ts` 做 6b 的 `budget_warning` 判定。
 */
import { budgetProgress } from '../budget.js'
import type { DashboardCtx } from './dashboard-ctx.js'

export interface DashboardTopCategory {
  name: string
  icon: string
  total: number
  percent: number
}

export interface DashboardBudgetItem {
  category_name: string
  category_icon: string
  amount: number
  spent: number
  percent: number
  status: string
  remaining: number
}

export interface DashboardBudget {
  top_categories: DashboardTopCategory[]
  budget_progress: DashboardBudgetItem[]
}

export function buildDashboardBudget(ctx: DashboardCtx): DashboardBudget {
  const { db, userId, year, month, today, startDate, endDate } = ctx

  // === 4. 当月分类支出 Top5 ===
  const categoryRows = db
    .prepare(
      `SELECT c.name, c.icon, SUM(t.amount) as total
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
         AND t.type = 'expense'
         AND t.date BETWEEN ? AND ?
       GROUP BY t.category_id
       ORDER BY total DESC
       LIMIT 5`,
    )
    .all(userId, startDate, endDate) as Array<{ name: string; icon: string; total: number }>

  const categoryTotal = categoryRows.reduce((sum, r) => sum + r.total, 0)
  const top_categories = categoryRows.map((r) => ({
    name: r.name,
    icon: r.icon,
    total: r.total,
    percent: categoryTotal ? Math.round((r.total / categoryTotal) * 1000) / 10 : 0,
  }))

  // === 5. 预算进度 ===
  const budgetRows = db
    .prepare(
      `SELECT b.id, b.category_id, b.month, b.amount, c.name as category_name, c.icon as category_icon
         FROM budgets b
         LEFT JOIN categories c ON b.category_id = c.id AND b.category_id != 0
        WHERE b.user_id = ? AND b.year = ? AND (b.month = ? OR b.month = 0)
        ORDER BY b.category_id`,
    )
    .all(userId, year, month) as Array<{
    id: number
    category_id: number
    month: number
    amount: number
    category_name: string | null
    category_icon: string | null
  }>

  // Pre-fetch category spending in batch (avoids N+1)。分两个区间：
  // 月度预算用请求月，全年预算（month=0）用「年初 → 今天」——否则全年进度
  // 会被算成当月进度（口径错误）。
  const sumByCategory = (from: string, to: string) => {
    const rows = db
      .prepare(
        `SELECT category_id, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND type = 'expense'
           AND status = 'confirmed' AND deleted_at IS NULL
           AND date BETWEEN ? AND ?
         GROUP BY category_id`,
      )
      .all(userId, from, to) as Array<{ category_id: number; total: number }>
    return {
      map: new Map(rows.map((r) => [r.category_id, r.total])),
      total: rows.reduce((sum, r) => sum + r.total, 0),
    }
  }
  const monthBucket = sumByCategory(startDate, endDate)
  const yearBucket = budgetRows.some((b) => b.month === 0)
    ? sumByCategory(`${year}-01-01`, today)
    : { map: new Map<number, number>(), total: 0 }

  const budget_progress: DashboardBudgetItem[] = budgetRows.map((b) => {
    // Use pre-fetched category spending data (single batch query)
    const bucket = b.month === 0 ? yearBucket : monthBucket
    const spent = b.category_id === 0 ? bucket.total : (bucket.map.get(b.category_id) || 0)
    const { percent, status, remaining } = budgetProgress(spent, b.amount)

    return {
      category_name: b.category_id === 0 ? '总预算' : (b.category_name || '未知'),
      category_icon: b.category_id === 0 ? '💰' : (b.category_icon || '📦'),
      amount: b.amount,
      spent,
      percent,
      status,
      remaining,
    }
  })

  return { top_categories, budget_progress }
}
