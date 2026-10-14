/**
 * 仪表盘聚合（`GET /api/stats/dashboard` 的读模型）
 *
 * 只负责**编排**：算一次「今天 / 年月 / 本月起止」再传给四个子读模型，最后按原顺序拼
 * `data`。分块见：
 * `dashboard-overview`（§1/2/3/9）· `dashboard-budget`（§4/5）·
 * `dashboard-alerts`（§6/7/8）· `dashboard-goals`（§10/11）。
 *
 * 路由只留「取 userId + 调这里 + 拼 code/message」。
 */
import { beijingYearMonth, monthRange, today as todayStr } from '../date.js'
import type { Db, DashboardCtx } from './dashboard-ctx.js'
import { buildDashboardOverview } from './dashboard-overview.js'
import { buildDashboardBudget } from './dashboard-budget.js'
import { buildDashboardAlerts } from './dashboard-alerts.js'
import { buildDashboardGoals } from './dashboard-goals.js'

export interface DashboardResult {
  summary: {
    expense: number
    income: number
    balance: number
    expense_change: number | null
    income_change: number | null
    transaction_count: number
    /** §9：储蓄率 */
    saving_rate: number
  }
  net_worth: ReturnType<typeof buildDashboardOverview>['net_worth']
  trend_7days: ReturnType<typeof buildDashboardOverview>['trend_7days']
  top_categories: ReturnType<typeof buildDashboardBudget>['top_categories']
  budget_progress: ReturnType<typeof buildDashboardBudget>['budget_progress']
  alerts: ReturnType<typeof buildDashboardAlerts>['alerts']
  recent_transactions: unknown[]
  goals_top: ReturnType<typeof buildDashboardGoals>['goals_top']
  subscriptions_overview: ReturnType<typeof buildDashboardGoals>['subscriptions_overview']
}

export function buildDashboard(db: Db, userId: number): DashboardResult {
  const { year, month } = beijingYearMonth()
  const { start: startDate, end: endDate } = monthRange(year, month)
  const today = todayStr()

  const ctx: DashboardCtx = { db, userId, year, month, today, startDate, endDate }

  const overview = buildDashboardOverview(ctx)
  const budget = buildDashboardBudget(ctx)
  // §6b 要读 §5 的预算进度 → 必须在 alerts 之前算好并传进去
  const alerts = buildDashboardAlerts(ctx, budget.budget_progress)
  const goals = buildDashboardGoals(ctx)

  return {
    summary: { ...overview.summary, saving_rate: overview.saving_rate },
    /**
     * 净资产 —— **唯一口径 = 总价值**（现金 + 持仓市值），来自 portfolio 读模型。
     *
     * 曾经这里还有 `total_assets` / `total_liabilities` / `asset_breakdown`，
     * 都是 `SUM(accounts.balance)` 的**现金口径**。Web 前端对这三项零使用
     * （负债改读 `portfolio.liability`，构成改读 `portfolio.assetComposition`），
     * Android 也不调本接口。留着只会让「净资产」这个数字在服务端有第二套算法。
     * 已删除：**要资产/负债拆分和构成，请用 `GET /api/assets/portfolio`**。
     */
    net_worth: overview.net_worth,
    trend_7days: overview.trend_7days,
    top_categories: budget.top_categories,
    budget_progress: budget.budget_progress,
    alerts: alerts.alerts,
    recent_transactions: alerts.recent_transactions,
    goals_top: goals.goals_top,
    subscriptions_overview: goals.subscriptions_overview,
  }
}
