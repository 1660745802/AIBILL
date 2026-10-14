/**
 * 月度收支摘要（`GET /api/stats/summary` 的读模型）
 *
 * 路由只做「解析参数 + 调这里 + 拼 `code/message`」；SQL、环比口径全在这里，
 * 与 `/api/stats/dashboard` 的 §1 摘要**刻意分开**（那块还要按当前北京时间
 * 取本月/上月，而本端点可由调用方指定任意年月）。
 */
import type { getDb } from '../../db/index.js'
import { monthRange, prevMonthRange, beijingYearMonth } from '../date.js'

type Db = ReturnType<typeof getDb>

/** `year` / `month` 缺省 = 北京当前年月 */
export interface StatsQuery {
  year?: string
  month?: string
}

export interface StatsSummary {
  year: number
  month: number
  expense: number
  income: number
  balance: number
  expense_count: number
  income_count: number
  prev_expense: number
  prev_income: number
  expense_change: number | null
  income_change: number | null
}

export function buildStatsSummary(db: Db, userId: number, query: StatsQuery): StatsSummary {
  const bj = beijingYearMonth()
  const year = parseInt(query.year || String(bj.year), 10)
  const month = parseInt(query.month || String(bj.month), 10)

  const { start: startDate, end: endDate } = monthRange(year, month)

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
  const { start: prevStartDate, end: prevEndDate } = prevMonthRange(year, month)

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
  }
}
