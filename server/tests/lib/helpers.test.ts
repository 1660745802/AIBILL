/**
 * 公共 lib 单元测试：日期区间 + 预算进度
 */
import { describe, it, expect } from 'vitest'
import { monthRange, prevMonthRange, toDateStr, dateOffset, today } from '../../src/lib/date.js'
import { budgetProgress, budgetStatus, spentPercent, WARN_PERCENT, OVER_PERCENT } from '../../src/lib/budget.js'
import { summarizeNetWorth } from '../../src/lib/assets.js'

describe('lib/date', () => {
  it('monthRange 应覆盖整月（大小月 + 闰年 2 月）', () => {
    expect(monthRange(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-01-31' })
    expect(monthRange(2026, 4)).toEqual({ start: '2026-04-01', end: '2026-04-30' })
    expect(monthRange(2024, 2)).toEqual({ start: '2024-02-01', end: '2024-02-29' }) // 闰年
    expect(monthRange(2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthRange(2026, 12)).toEqual({ start: '2026-12-01', end: '2026-12-31' })
  })

  it('prevMonthRange 应正确跨年', () => {
    expect(prevMonthRange(2026, 1)).toEqual({ start: '2025-12-01', end: '2025-12-31' })
    expect(prevMonthRange(2026, 3)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(prevMonthRange(2024, 3)).toEqual({ start: '2024-02-01', end: '2024-02-29' })
  })

  it('toDateStr / today / dateOffset 应输出合法 YYYY-MM-DD', () => {
    expect(toDateStr(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(toDateStr(new Date(2026, 11, 31))).toBe('2026-12-31')
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dateOffset(0)).toBe(today())
    expect(dateOffset(-6) <= today()).toBe(true)
    // 连续 7 天
    const week = Array.from({ length: 7 }, (_, i) => dateOffset(-6 + i))
    expect(new Set(week).size).toBe(7)
  })
})

describe('lib/budget', () => {
  it('spentPercent 应四舍五入，amount<=0 返回 0', () => {
    expect(spentPercent(3200, 10000)).toBe(32)
    expect(spentPercent(1, 3)).toBe(33)
    expect(spentPercent(9999, 0)).toBe(0)
  })

  it('budgetStatus 应遵守 80% / 100% 阈值', () => {
    expect(WARN_PERCENT).toBe(80)
    expect(OVER_PERCENT).toBe(100)
    expect(budgetStatus(0)).toBe('normal')
    expect(budgetStatus(79)).toBe('normal')
    expect(budgetStatus(80)).toBe('warning')
    expect(budgetStatus(99)).toBe('warning')
    expect(budgetStatus(100)).toBe('exceeded')
    expect(budgetStatus(150)).toBe('exceeded')
  })

  it('budgetProgress 应一次给出 percent/status/remaining', () => {
    expect(budgetProgress(8000, 10000)).toEqual({ percent: 80, status: 'warning', remaining: 2000 })
    expect(budgetProgress(12000, 10000)).toEqual({ percent: 120, status: 'exceeded', remaining: 0 })
    expect(budgetProgress(0, 10000)).toEqual({ percent: 0, status: 'normal', remaining: 10000 })
  })
})

describe('lib/assets - 净资产口径', () => {
  const acc = (balance: number) => ({ balance })

  it('全为正余额时无负债', () => {
    expect(summarizeNetWorth([acc(100000), acc(50000), acc(0)])).toEqual({
      total_assets: 150000,
      total_liabilities: 0,
      net_worth: 150000,
    })
  })

  it('负余额一律计入负债（不论 asset_type）', () => {
    // 活期透支 50000 + 信用卡欠款 80000
    expect(summarizeNetWorth([acc(200000), acc(-50000), acc(-80000)])).toEqual({
      total_assets: 200000,
      total_liabilities: 130000,
      net_worth: 70000,
    })
  })

  it('信用卡溢缴款（正余额）算资产，不抵扣其他卡的欠款', () => {
    // 早期 dashboard 的 bug：按 asset_type 求和后取绝对值 → 100 溢缴抵消了 500 欠款
    expect(summarizeNetWorth([acc(-50000), acc(10000)])).toEqual({
      total_assets: 10000,
      total_liabilities: 50000,
      net_worth: -40000,
    })
  })

  it('净资产 = 所有账户余额之和（会计恒等式）', () => {
    const balances = [12345, -6789, 0, 100000, -1, -30000, 555]
    const r = summarizeNetWorth(balances.map(acc))
    expect(r.net_worth).toBe(balances.reduce((s, b) => s + b, 0))
    expect(r.total_assets - r.total_liabilities).toBe(r.net_worth)
  })

  it('全负余额时净负债', () => {
    expect(summarizeNetWorth([acc(-10000), acc(-20000)])).toEqual({
      total_assets: 0,
      total_liabilities: 30000,
      net_worth: -30000,
    })
  })

  it('空账户列表应返回全 0 而不是 NaN', () => {
    expect(summarizeNetWorth([])).toEqual({
      total_assets: 0,
      total_liabilities: 0,
      net_worth: 0,
    })
  })
})
