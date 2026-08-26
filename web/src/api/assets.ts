import api from './index'

export interface AssetOverview {
  total_assets: number
  total_liabilities: number
  net_worth: number
  by_type: Array<{ type: string; total: number; count: number }>
  accounts: Array<{
    id: number
    name: string
    type: string
    icon: string
    asset_type: string
    balance: number
    credit_limit: number
    billing_day: number
    due_day: number
    note: string | null
  }>
}

export interface TrendPoint {
  snapshot_date: string
  net_worth: number
}

export function getAssetsOverview() {
  return api.get<{ code: number; data: AssetOverview }>('/assets/overview')
}

export function getAssetsTrend(months = 6) {
  return api.get<{ code: number; data: { trend: TrendPoint[]; months: number } }>(
    '/assets/trend', { params: { months } }
  )
}

export function createSnapshot() {
  return api.post<{ code: number; data: { date: string; created: number }; message: string }>(
    '/assets/snapshot'
  )
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
