/**
 * 仪表盘 · §6 异常提醒 + §7 最近流水 + §8 订阅到期提醒
 *
 * §6 三条规则都往**同一个** `alerts` 数组里 push（6a 大额支出 → 6b 预算超阈值 →
 * §8 订阅到期），顺序即展示顺序；`alerts` 里既有大额提醒又有订阅提醒，不是分组的，
 * 所以三个小节必须在同一函数里保持 push 顺序。
 */
import { today as todayStr, dateOffset, daysUntil } from '../date.js'
import { WARN_PERCENT } from '../budget.js'
import type { DashboardCtx } from './dashboard-ctx.js'
import type { DashboardBudgetItem } from './dashboard-budget.js'

export interface DashboardAlert {
  type: string
  message: string
  data?: any
}

export interface DashboardAlerts {
  alerts: DashboardAlert[]
  recent_transactions: unknown[]
}

export function buildDashboardAlerts(
  ctx: DashboardCtx,
  budgetProgressList: DashboardBudgetItem[],
): DashboardAlerts {
  const { db, userId, today, startDate, endDate } = ctx

  const alerts: Array<{ type: string; message: string; data?: any }> = []

  // 6a. large_expense: 今日单笔 > 日均支出 * 5
  const avgDailyResult = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(DISTINCT date) as days
       FROM transactions
       WHERE user_id = ? AND type = 'expense'
         AND status = 'confirmed' AND deleted_at IS NULL
         AND date BETWEEN ? AND ?`,
    )
    .get(userId, startDate, endDate) as { total: number; days: number }

  const avgDaily = avgDailyResult.days > 0 ? avgDailyResult.total / avgDailyResult.days : 0

  if (avgDaily > 0) {
    const largeToday = db
      .prepare(
        `SELECT id, amount, description
         FROM transactions
         WHERE user_id = ? AND type = 'expense'
           AND status = 'confirmed' AND deleted_at IS NULL
           AND date = ?
           AND amount > ?
         ORDER BY amount DESC
         LIMIT 3`,
      )
      .all(userId, today, avgDaily * 5) as Array<{ id: number; amount: number; description: string | null }>

    for (const tx of largeToday) {
      alerts.push({
        type: 'large_expense',
        message: `今日大额支出：${tx.description || '未备注'} ¥${(tx.amount / 100).toFixed(2)}，超过日均${Math.round(tx.amount / avgDaily)}倍`,
        data: { transaction_id: tx.id, amount: tx.amount },
      })
    }
  }

  // 6b. budget_warning: 预算使用超过阈值
  for (const bp of budgetProgressList) {
    if (bp.percent >= WARN_PERCENT) {
      alerts.push({
        type: 'budget_warning',
        message: `${bp.category_name}预算已使用${bp.percent}%${bp.status === 'exceeded' ? '，已超支！' : '，请注意控制'}`,
        data: { category_name: bp.category_name, percent: bp.percent, status: bp.status },
      })
    }
  }

  // === 7. 最近流水(5笔) ===
  const recent_transactions = db
    .prepare(
      `SELECT t.id, t.type, t.amount, t.description, t.date, t.time,
              c.name as category_name, c.icon as category_icon,
              a.name as account_name, a.icon as account_icon
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT 5`,
    )
    .all(userId)

  // === 8. 订阅到期提醒 ===
  const todayStrLocal = todayStr()
  const in7days = dateOffset(7)
  const upcomingSubs = db
    .prepare(
      `SELECT name, amount, next_payment_date FROM subscriptions
       WHERE user_id = ? AND status = 'active'
         AND next_payment_date IS NOT NULL
         AND next_payment_date BETWEEN ? AND ?
       ORDER BY next_payment_date ASC
       LIMIT 5`,
    )
    .all(userId, todayStrLocal, in7days) as Array<{ name: string; amount: number; next_payment_date: string }>

  for (const sub of upcomingSubs) {
    // 按北京时间的「整数天」算，不是 UTC 午夜 vs 当前瞬时——后者在北京
    // 00:00–08:00 会把「今天扣费」算成「明天」（审查 MINOR-1）
    const daysLeft = daysUntil(sub.next_payment_date)
    const dayText = daysLeft <= 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft}天后`
    alerts.push({
      type: 'subscription_due',
      message: `${sub.name} ${dayText}扣费 ¥${(sub.amount / 100).toFixed(2)}`,
    })
  }

  return { alerts, recent_transactions }
}
