import api from './index'

/**
 * 单条持仓 + 最新行情估值。
 *
 * **只有 代码 / 名称 / 股数 / 现价 / 市值**——单只不记成本、不算盈亏
 * （用户要求「投入不要针对单只持仓股，计算总投入就可以」）。
 * 盈亏只有一个数，在账户级（见 `/api/assets/portfolio`）。
 *
 * 说「未取到价」而不是 0：行情缺失时 `marketValue` 为 null，UI 显示「—」。
 */
export interface InvestmentItem {
  id: number
  accountId: number
  code: string
  name: string | null
  market: string | null
  kind: string
  quantity: number
  note: string | null
  updatedAt: string
  /** 股数 × 现价，**已折人民币**（分）。行情缺失时 null —— 不要显示 0 */
  marketValue: number | null
  /** 该标的自己的币种市值（分），用来显示「原币 HK$417,480」 */
  marketValueNative: number | null
  /** 持仓计价币种：HKD / USD / CNY */
  currency: string
  /** 折算汇率；人民币为 1，缺汇率为 null（这时 marketValue 也是 null） */
  fxRate: number | null
  /** 有行情且股数 > 0 */
  valued: boolean
  quote: { name: string | null; price: number; quoteDate: string; changeRate: number | null } | null
}

export interface InvestmentList {
  items: InvestmentItem[]
}

export function listInvestments() {
  return api.get<{ code: number; data: InvestmentList }>('/investments')
}

export function createInvestment(data: {
  account_id: number
  code: string
  name?: string | null
  kind?: string
  quantity: number
  note?: string | null
}) {
  return api.post('/investments', data)
}

/** 加减仓：只改股数。总投入是账户级的，不在这里改 */
export function updateInvestment(id: number, data: {
  name?: string | null
  quantity?: number
  note?: string | null
}) {
  return api.patch(`/investments/${id}`, data)
}

export function deleteInvestment(id: number) {
  return api.delete(`/investments/${id}`)
}
