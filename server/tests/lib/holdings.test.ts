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
  code, name: null, price, quoteDate: '2026-10-09', quotedAt: '20261009161456', changeRate: 1.69,
})

describe('valueHolding', () => {
  it('市值 = 股数 × 现价（分）', () => {
    const v = valueHolding(holding({ id: 1, code: 'sh518880', quantity: 10000 }), new Map([['sh518880', quote('sh518880', 8.617)]]))
    expect(v.marketValue).toBe(8617000)   // 10,000 × 8.617 元 = ¥86,170
    expect(v.valued).toBe(true)
    expect(v.quote?.price).toBe(8.617)
  })

  it.each(['hf_XAU', 'hf_xau'])('克数持仓 %s 按金衡盎司报价换算', (code) => {
    const v = valueHolding(
      holding({ id: 1, code, kind: 'gold_gram', quantity: 31.1034768 }),
      new Map([[code, quote(code, 4000)]]), new Map([['USD', 7]]),
    )
    expect(v.marketValueNative).toBe(400000)
    expect(v.marketValue).toBe(2800000)
    expect(v.valued).toBe(true)
    expect(v.quote?.price).toBe(4000)
  })

  it.each(['etf', 'stock'])('%s 仍按份额/股数估值，不按黄金克数换算', (kind) => {
    const v = valueHolding(
      holding({ id: 1, code: 'hf_XAU', kind, quantity: 2 }),
      new Map([['hf_XAU', quote('hf_XAU', 4000)]]), new Map([['USD', 7]]),
    )
    expect(v.marketValueNative).toBe(800000)
    expect(v.marketValue).toBe(5600000)
  })

  it('人民币每克报价不作盎司换算', () => {
    const v = valueHolding(
      holding({ id: 1, code: 'gold_cny', kind: 'gold_gram', quantity: 10 }),
      new Map([['gold_cny', quote('gold_cny', 900)]]),
    )
    expect(v.marketValue).toBe(900000)
  })

  it.each([
    ['sh518880', false], ['usAAPL', false], ['usAAPL', true], ['hf_XAU', false],
  ] as const)('零数量 %s（有行情=%s）即使无汇率也确定为零', (code, withQuote) => {
    const v = valueHolding(
      holding({ id: 1, code, quantity: 0 }),
      withQuote ? new Map([[code, quote(code, 200)]]) : new Map(),
    )
    expect(v.marketValueNative).toBe(0)
    expect(v.marketValue).toBe(0)
    expect(v.valued).toBe(false)
  })

  it('非零外币持仓缺汇率仍不可估值', () => {
    const v = valueHolding(
      holding({ id: 1, code: 'usAAPL', quantity: 1 }),
      new Map([['usAAPL', quote('usAAPL', 200)]]),
    )
    expect(v.marketValueNative).toBe(20000)
    expect(v.marketValue).toBeNull()
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

  it('零数量缺价/缺汇率不抹去同账户其它持仓市值', () => {
    const m = groupByAccount([
      holding({ id: 1, accountId: 2, code: 'sh518880', quantity: 10000 }),
      holding({ id: 2, accountId: 2, code: 'sh999999', quantity: 0 }),
      holding({ id: 3, accountId: 2, code: 'usAAPL', quantity: 0 }),
      holding({ id: 4, accountId: 9, code: 'hf_XAU', quantity: 0 }),
    ], quotes)
    expect(m.get(2)).toEqual({ marketValue: 8617000, unpricedCount: 0 })
    expect(m.get(9)).toEqual({ marketValue: 0, unpricedCount: 0 })
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
