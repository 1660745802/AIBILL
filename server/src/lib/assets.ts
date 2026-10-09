/**
 * 净资产口径计算（dashboard 与 assets/overview 共用）
 *
 * ## 统一口径
 * - **总资产** = 所有余额为正（或为 0）的账户余额之和
 * - **总负债** = 所有余额为负的账户的绝对值之和
 * - **净资产** = 总资产 − 总负债 = 所有账户余额之和
 *
 * ## 为什么按「余额正负」而不是按 asset_type 判断负债
 *
 * 1. **会计恒等式**：两个接口的 `net_worth` 都是「所有账户余额之和」，
 *    只有上面的口径能让 `总资产 − 总负债 = 净资产` 成立。
 *    早期 dashboard 版本按 asset_type 分组后取绝对值：
 *    两张信用卡一欠 -500、一溢缴 +100 时会互相抵消成 400，
 *    而真实欠款是 500；同时它漏算了活期账户透支。
 * 2. **负余额本身就是「欠钱」**：信用卡欠款是负债，活期账户透支同样是负债。
 *    asset_type（活期/定期/投资/信用卡/贷款…）只用于**展示分组**，
 *    不该影响「这笔钱是不是债」的判断。
 */

export interface AccountBalance {
  /** 分 */
  balance: number
}

export interface NetWorthSummary {
  total_assets: number
  total_liabilities: number
  net_worth: number
}

export function summarizeNetWorth(accounts: AccountBalance[]): NetWorthSummary {
  let totalAssets = 0
  let totalLiabilities = 0

  for (const acc of accounts) {
    if (acc.balance < 0) {
      totalLiabilities += Math.abs(acc.balance)
    } else {
      totalAssets += acc.balance
    }
  }

  return {
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    net_worth: totalAssets - totalLiabilities,
  }
}
