/**
 * 仪表盘 · §1 月度摘要 + §2 净资产 + §3 7 天支出趋势 + §9 储蓄率
 *
 * §9 的 `saving_rate` 与 §1 出自同一次查询（都用 `income`/`expense`），所以一起算，
 * 由 `dashboard.ts` 合并进 `summary`（原 handler 就是 `{ ...summary, saving_rate }`）。
 */
import { addDaysTo } from '../date.js'
import { buildPortfolio, readAccounts, readHistory, countAccounts } from '../portfolio.js'
import { loadAccountHoldings } from '../investments-repo.js'
import type { DashboardCtx } from './dashboard-ctx.js'

export interface DashboardOverview {
  summary: {
    expense: number
    income: number
    balance: number
    expense_change: number | null
    income_change: number | null
    transaction_count: number
  }
  /** §9：本月储蓄率（0~100） */
  saving_rate: number
  net_worth: {
    total: number
    netWorthComplete: boolean
    unpricedAccounts: number
    accounts: Array<{
      id: number
      name: string
      icon: string | null
      asset_type: string
      cash: number
      value: number | null
    }>
  }
  trend_7days: Array<{ date: string; total: number }>
}

export function buildDashboardOverview(ctx: DashboardCtx): DashboardOverview {
  const { db, userId, year, month, today, startDate, endDate } = ctx

  // === 1. 月度摘要 ===
  const summaryRows = db
    .prepare(
      `SELECT type, SUM(amount) as total, COUNT(*) as count
       FROM transactions
       WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
         AND type IN ('expense', 'income')
         AND date BETWEEN ? AND ?
       GROUP BY type`,
    )
    .all(userId, startDate, endDate) as Array<{ type: string; total: number; count: number }>

  let expense = 0, income = 0, transactionCount = 0
  for (const row of summaryRows) {
    if (row.type === 'expense') { expense = row.total; transactionCount += row.count }
    if (row.type === 'income') { income = row.total; transactionCount += row.count }
  }

  // 上月数据（环比）
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  const prevStartDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
  const prevLastDay = new Date(prevYear, prevMonth, 0).getDate()
  const prevEndDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`

  const prevRows = db
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
  for (const row of prevRows) {
    if (row.type === 'expense') prevExpense = row.total
    if (row.type === 'income') prevIncome = row.total
  }

  const summary = {
    expense,
    income,
    balance: income - expense,
    expense_change: prevExpense ? Math.round(((expense - prevExpense) / prevExpense) * 100) : null,
    income_change: prevIncome ? Math.round(((income - prevIncome) / prevIncome) * 100) : null,
    transaction_count: transactionCount,
  }

  // === 2. 净资产（与 /api/assets/portfolio 同一个读模型、同一个口径） ===
  //
  // 曾经这里自己写了一遍 `SUM(a.balance)`（**现金口径**，不含持仓市值），
  // 而仪表读的是 portfolio 的**总价值口径**——同一个数字两套算法，
  // 正是本项目大半历史 bug 的来源。现在直接复用 buildPortfolio，
  // 读取源在 `lib/portfolio.ts`，两个接口结构上不可能再漂移。
  //
  // 「今天」用 `lib/date.ts` 的 `today()`（北京时间，全仓唯一口径），与
  // portfolio 路由取同一个值，否则 `staleDays` 会在两个接口之间差一天。
  const portfolioToday = today
  const portfolio = buildPortfolio(
    readAccounts(db, userId),
    readHistory(db, userId),
    countAccounts(db, userId),
    portfolioToday,
    loadAccountHoldings(db, userId),
  )

  /**
   * `accounts` 仍返回（Dashboard 用它的 `length` 判断空态），但每行补上
   * **总价值 `value`**（行情缺失为 null）。
   *
   * `cash` 与 `value` 是两个真实存在、都该给的量：`cash` 是账户现金，
   * `value = cash + 持仓市值`。**净资产用的是 `value`，不是 `cash`**——
   * 挂了持仓的账户两者差着整整一块持仓市值。
   * `total = Σ(value ?? cash)`（行情缺失的账户只计入已知的现金 → 下界）。
   */
  const net_worth = {
    total: portfolio.netWorth,
    /** false = `total` 是个下界，UI 必须显示「≥¥X」而不是当精确值 */
    netWorthComplete: portfolio.netWorthComplete,
    unpricedAccounts: portfolio.unpricedAccounts,
    accounts: portfolio.accounts.map((a) => ({
      id: a.accountId,
      name: a.name,
      icon: a.icon,
      asset_type: a.assetType,
      cash: a.cash,
      value: a.value,
    })),
  }

  // === 3. 7天支出趋势 ===
  // 以 ctx 里那**一个** `today` 为基准推 7 天。
  // 以前这里是 `dateOffset(-6)` + 循环里再调 7 次 `dateOffset()`，每次各自取一次
  // `Date.now()`；跨北京午夜时最后一个点会落到下面 SQL 的窗口之外（`today` 更早）
  // 而恒显示 0。同一个响应里的日期必须出自同一个基准。
  const trendDates = Array.from({ length: 7 }, (_, i) => addDaysTo(today, i - 6))
  const sevenDaysAgoStr = trendDates[0]!

  const trendRows = db
    .prepare(
      `SELECT date, SUM(amount) as total
       FROM transactions
       WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
         AND type = 'expense'
         AND date BETWEEN ? AND ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(userId, sevenDaysAgoStr, today) as Array<{ date: string; total: number }>

  const trendMap = new Map(trendRows.map((r) => [r.date, r.total]))
  const trend_7days: Array<{ date: string; total: number }> = trendDates.map((dateStr) => ({
    date: dateStr,
    total: trendMap.get(dateStr) || 0,
  }))

  // === 9. 储蓄率（本月收入 - 支出 / 收入） ===
  const saving_rate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0

  return { summary, saving_rate, net_worth, trend_7days }
}
