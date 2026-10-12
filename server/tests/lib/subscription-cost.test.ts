/**
 * 订阅月/年折算的**唯一口径**
 *
 * 回归：同一件事曾在三处各写一遍、两种舍入顺序（列表逐条取整、仪表先 SUM 再取整、
 * 分析不取整），两笔季度 ¥100 会得到 66 与 67 两个答案。
 * 这里锁住「先按精确值折算求和，最后统一取整一次」。
 */
import { describe, it, expect } from 'vitest'
import { subscriptionCosts } from '../../src/lib/subscription-cost.js'

describe('subscriptionCosts', () => {
  it('三种周期各自折算：monthly 原值、quarterly /3、yearly /12', () => {
    const r = subscriptionCosts([
      { amount: 1500, cycle: 'monthly' },
      { amount: 2100, cycle: 'quarterly' },
      { amount: 48000, cycle: 'yearly' },
    ])
    expect(r.monthlyTotal).toBe(1500 + 700 + 4000)
    expect(r.yearlyTotal).toBe(1500 * 12 + 2100 * 4 + 48000)
  })

  it('除不尽时先求和再取整，不逐条取整（两笔季度 ¥100 ≠ 66）', () => {
    const r = subscriptionCosts([
      { amount: 100, cycle: 'quarterly' },
      { amount: 100, cycle: 'quarterly' },
    ])
    // 逐条取整是 33 + 33 = 66；正确口径是 round(200 / 3) = 67
    expect(r.monthlyTotal).toBe(67)
    // 年费是整数运算，永远精确
    expect(r.yearlyTotal).toBe(800)
  })

  it('yearly 的月均：100 分/年 → 8 分/月（四舍五入一次）', () => {
    expect(subscriptionCosts([{ amount: 100, cycle: 'yearly' }])).toEqual({
      monthlyTotal: 8,
      yearlyTotal: 100,
    })
  })

  it('未知 cycle 跳过，不猜也不当按月', () => {
    const r = subscriptionCosts([
      { amount: 9999, cycle: 'weekly' },
      { amount: 1200, cycle: 'monthly' },
    ])
    expect(r).toEqual({ monthlyTotal: 1200, yearlyTotal: 14400 })
  })

  it('空列表 → 0（不是 NaN）', () => {
    expect(subscriptionCosts([])).toEqual({ monthlyTotal: 0, yearlyTotal: 0 })
  })
})
