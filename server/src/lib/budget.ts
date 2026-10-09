/**
 * 预算进度计算
 *
 * 原先这段“已用百分比 + 状态”在 stats/dashboard、budgets 列表、
 * 交易创建后的预警里各写了一遍，阈值（80% / 100%）也重复了三处。
 * 收拢到这里后，改阈值只需改一个地方。
 */

/** 预警阈值：达到 80% 提醒，100% 判定超支 */
export const WARN_PERCENT = 80
export const OVER_PERCENT = 100

export type BudgetStatus = 'normal' | 'warning' | 'exceeded'

/** 已用金额 → 百分比（amount <= 0 视为 0） */
export function spentPercent(spent: number, amount: number): number {
  if (amount <= 0) return 0
  return Math.round((spent / amount) * 100)
}

/** 百分比 → 状态 */
export function budgetStatus(percent: number): BudgetStatus {
  if (percent >= OVER_PERCENT) return 'exceeded'
  if (percent >= WARN_PERCENT) return 'warning'
  return 'normal'
}

/** 一次性算出 percent / status / remaining */
export function budgetProgress(spent: number, amount: number): {
  percent: number
  status: BudgetStatus
  remaining: number
} {
  const percent = spentPercent(spent, amount)
  return { percent, status: budgetStatus(percent), remaining: Math.max(0, amount - spent) }
}
