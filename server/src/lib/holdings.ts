/**
 * 持仓估值
 *
 * 把「持仓（低频、你填）」和「行情（高频、系统抓）」合成市值：
 *
 *   市值 = 股数 × 现价
 *
 * **单只不算盈亏。** 用户明确要求「投入不要针对单只持仓股，计算总投入就可以」，
 * 所以这里没有 cost_basis、没有成本价、没有单只浮盈。盈亏只在账户级出一个数
 * （见 lib/portfolio.ts：账户总价值 − 总投入）。
 *
 * 这同时消掉一个真实出现过的矛盾：页面上「头条浮盈 +14,170」和
 * 「同一只持仓行 −13,830」正负号打架，根因就是单只也算了成本。
 *
 * 行情缺失时市值给 **null 而不是 0**：0 会被读成「这只持仓归零了」，
 * 那是错误信息；null 才是「我暂时不知道它值多少」。
 */

export interface Holding {
  id: number
  accountId: number
  code: string
  name: string | null
  kind: string
  quantity: number
  note: string | null
  isActive: boolean
  updatedAt: string
}

export interface QuoteLite {
  code: string
  /** 行情返回的名称。持仓没填名字时用它兜底显示 */
  name: string | null
  price: number
  quoteDate: string
  quotedAt: string
  changeRate: number | null
}

export interface HoldingValuation extends Holding {
  /** 股数 × 现价（分）。行情缺失时 null */
  marketValue: number | null
  /** 有行情且股数 > 0 —— UI 据此决定显示市值还是「—」 */
  valued: boolean
  quote: QuoteLite | null
}

export function valueHolding(h: Holding, quotes: Map<string, QuoteLite>): HoldingValuation {
  const quote = quotes.get(h.code) ?? null
  const marketValue = quote ? Math.round(h.quantity * quote.price * 100) : null
  return {
    ...h,
    marketValue,
    valued: marketValue != null && h.quantity > 0,
    quote,
  }
}

/** 一个账户下的持仓估值汇总 */
export interface AccountHoldings {
  /**
   * 持仓市值合计（分）。
   * **只要有任一标的取不到行情就为 null** —— 不拿部分之和冒充完整市值。
   */
  marketValue: number | null
  /** 取不到行情的标的数；UI 要说「有 N 个没取到价」而不是假装完整 */
  unpricedCount: number
}

/**
 * 把持仓按账户分组估值。
 * 返回的 Map 只包含**确实有持仓**的账户；调用方据此判断「该账户挂了持仓」，
 * 从而把快照里的 balance 当现金而不是总价值。
 */
export function groupByAccount(
  holdings: Holding[],
  quotes: Map<string, QuoteLite>,
): Map<number, AccountHoldings> {
  const byAccount = new Map<number, HoldingValuation[]>()
  for (const h of holdings) {
    if (!h.isActive) continue
    const arr = byAccount.get(h.accountId) ?? []
    arr.push(valueHolding(h, quotes))
    byAccount.set(h.accountId, arr)
  }

  const out = new Map<number, AccountHoldings>()
  for (const [accountId, rows] of byAccount) {
    const unpricedCount = rows.filter((r) => r.marketValue == null).length
    out.set(accountId, {
      marketValue: unpricedCount > 0
        ? null
        : rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
      unpricedCount,
    })
  }
  return out
}
