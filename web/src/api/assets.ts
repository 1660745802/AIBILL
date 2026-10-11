import api from './index'

export interface AssetOverview {
  /**
   * 本接口**不提供任何净资产口径的字段**。
   *
   * 以前这里有 `total_assets` / `total_liabilities` / `net_worth` / `by_type`，
   * 都是 `Σ accounts.balance` 的**现金口径**（不含持仓市值），而仪表读的是
   * portfolio 的总价值口径——同一个数字两套算法。Web 对这四项零使用
   * （负债改读 `portfolio.liability`、构成改读 `portfolio.assetComposition`）。
   * 已删除：**要净资产/负债/构成，请用 `/api/assets/portfolio`**。
   */
  accounts: Array<{
    id: number
    name: string
    type: string
    icon: string
    asset_type: string
    /** 现金余额（分）。理财账户还要加持仓市值——那部分在 portfolio 里算 */
    balance: number
    credit_limit: number
    billing_day: number
    due_day: number
    note: string | null
  }>
}

export function getAssetsOverview() {
  return api.get<{ code: number; data: AssetOverview }>('/assets/overview')
}

export function updateAccountAsset(id: number, data: {
  asset_type?: string
  credit_limit?: number
  billing_day?: number
  due_day?: number
  note?: string
}) {
  return api.put(`/assets/accounts/${id}`, data)
}
