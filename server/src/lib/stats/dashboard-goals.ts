/**
 * 仪表盘 · §10 活跃目标 Top3 + §11 订阅概览
 *
 * §11 的月费折算口径唯一实现在 `lib/subscription-cost.ts`（以前这里与
 * `/api/subscriptions` 各写一遍，且一个先 SUM 再取整、一个逐条取整 →
 * 同一份数据能出两个数）。
 */
import { monthOffset } from '../date.js'
import { subscriptionCosts } from '../subscription-cost.js'
import type { DashboardCtx } from './dashboard-ctx.js'

export interface DashboardGoalsTop {
  id: number
  name: string
  icon: string
  target_amount: number
  current_amount: number
  percent: number
  remaining: number
  deadline: string | null
  estimated_completion: string | null
}

export interface DashboardSubscriptions {
  active_count: number
  monthly_total: number
  yearly_total: number
}

export interface DashboardGoals {
  goals_top: DashboardGoalsTop[]
  subscriptions_overview: DashboardSubscriptions
}

export function buildDashboardGoals(ctx: DashboardCtx): DashboardGoals {
  const { db, userId } = ctx

  // === 10. 活跃目标（Top 3） ===
  const goalsRows = db
    .prepare(
      `SELECT id, name, icon, target_amount, current_amount, type, deadline, priority, monthly_contribution
         FROM financial_goals
        WHERE user_id = ? AND status = 'active'
        ORDER BY priority ASC, created_at DESC
        LIMIT 3`,
    )
    .all(userId) as Array<{
    id: number
    name: string
    icon: string
    target_amount: number
    current_amount: number
    type: string
    deadline: string | null
    priority: number
    monthly_contribution: number
  }>

  const goals_top = goalsRows.map((g) => {
    const percent = g.target_amount > 0
      ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100))
      : 0
    const remaining = Math.max(0, g.target_amount - g.current_amount)
    let estimated_completion: string | null = null
    if (g.monthly_contribution > 0 && remaining > 0) {
      const monthsLeft = Math.ceil(remaining / g.monthly_contribution)
      estimated_completion = monthOffset(monthsLeft)
    }
    return {
      id: g.id,
      name: g.name,
      icon: g.icon,
      target_amount: g.target_amount,
      current_amount: g.current_amount,
      percent,
      remaining,
      deadline: g.deadline,
      estimated_completion,
    }
  })

  // === 11. 订阅概览（活跃订阅 + 月费折算） ===
  const subRows = db
    .prepare(
      `SELECT amount, cycle FROM subscriptions WHERE user_id = ? AND status = 'active'`,
    )
    .all(userId) as Array<{ amount: number; cycle: string }>
  const subCost = subscriptionCosts(subRows)
  const subscriptions_overview = {
    active_count: subRows.length,
    monthly_total: subCost.monthlyTotal,
    yearly_total: subCost.yearlyTotal,
  }

  return { goals_top, subscriptions_overview }
}
