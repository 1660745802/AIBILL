/**
 * 持仓估值单元测试
 *
 * 新模型：单只只算市值（股数 × 现价），**不算盈亏**——
 * 用户明确「投入不要针对单只持仓股，计算总投入就可以」。
 * 盈亏只在账户级出一个数（lib/portfolio.ts）。
 *
 * 两条不变的硬规则：
 *   「未取到价」不是 0 —— 无行情时市值给 null，显示「—」
 *   「未配置」不是亏损 —— 没持仓时账户级浮盈给 null
 */
import { describe, it, expect } from 'vitest'
import { valueHolding, groupByAccount, type Holding, type QuoteLite } from '../../src/lib/holdings.js'

const holding = (o: Partial<Holding> & { id: number; code: string }): Holding => ({
  accountId: 2,
  name: null,
  kind: 'etf',
  quantity: 0,
  note: null,
  isActive: true,
  updatedAt: '2026-10-10',
  ...o,
})

const quote = (code: string, price: number): QuoteLite => ({
  code, price, quoteDate: '2026-10-09', quotedAt: '20261009161456', changeRate: 1.69,
})

describe('valueHolding', () => {
  it('市值 = 股数 × 现价（分）', () => {
    const v = valueHolding(holding({ id: 1, code: 'sh518880', quantity: 10000 }), new Map([['sh518880', quote('sh518880', 8.617)]]))
    expect(v.marketValue).toBe(8617000)   // 10,000 × 8.617 元 = ¥86,170
    expect(v.valued).toBe(true)
    expect(v.quote?.price).toBe(8.617)
  })

  it('不再有成本价 / 单只浮盈（这是本轮的删除项）', () => {
    const v = valueHolding(holding({ id: 1, code: 'sh518880', quantity: 10000 }), new Map([['sh518880', quote('sh518880', 8.617)]]))
    const keys = Object.keys(v)
    expect(keys).not.toContain('costPrice')
    expect(keys).not.toContain('unrealized')
    expect(keys).not.toContain('costBasis')
  })

  it('没有行情 → 市值 null，不是 0（0 会被读成"归零了"）', () => {
    const v = valueHolding(holding({ id: 1, code: 'sh518880', quantity: 10000 }), new Map())
    expect(v.marketValue).toBeNull()
    expect(v.valued).toBe(false)
    expect(v.quote).toBeNull()
  })

  it('股数为 0 → valued=false，但市值仍按行情算（清仓后留档）', () => {
    const v = valueHolding(holding({ id: 1, code: 'sh518880', quantity: 0 }), new Map([['sh518880', quote('sh518880', 8.617)]]))
    expect(v.marketValue).toBe(0)
    expect(v.valued).toBe(false)
  })
})

describe('groupByAccount', () => {
  const quotes = new Map([
    ['sh518880', quote('sh518880', 8.617)],
    ['sh510300', quote('sh510300', 4.317)],
  ])

  it('按账户分组，市值合计', () => {
    const m = groupByAccount([
      holding({ id: 1, accountId: 2, code: 'sh518880', quantity: 10000 }),
      holding({ id: 2, accountId: 2, code: 'sh510300', quantity: 5000 }),
      holding({ id: 3, accountId: 9, code: 'sh510300', quantity: 1000 }),
    ], quotes)
    // 86,170 + 21,585 = 107,755
    expect(m.get(2)!.marketValue).toBe(8617000 + 2158500)
    expect(m.get(9)!.marketValue).toBe(431700)
    expect(m.get(2)!.unpricedCount).toBe(0)
  })

  it('任一标的取不到价 → 该账户市值整体给 null（不拿部分之和冒充）', () => {
    const m = groupByAccount([
      holding({ id: 1, accountId: 2, code: 'sh518880', quantity: 10000 }),
      holding({ id: 2, accountId: 2, code: 'sh999999', quantity: 100 }),  // 无行情
    ], quotes)
    expect(m.get(2)!.marketValue).toBeNull()
    expect(m.get(2)!.unpricedCount).toBe(1)
  })

  it('只包含确实有持仓的账户（调用方据此判断"挂了持仓"）', () => {
    const m = groupByAccount([
      holding({ id: 1, accountId: 2, code: 'sh518880', quantity: 10000 }),
    ], quotes)
    expect(m.has(2)).toBe(true)
    expect(m.has(99)).toBe(false)
  })

  it('is_active=0 的持仓不参与', () => {
    const m = groupByAccount([
      holding({ id: 1, accountId: 2, code: 'sh518880', quantity: 10000, isActive: false }),
    ], quotes)
    expect(m.has(2)).toBe(false)
  })
})
