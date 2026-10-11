/**
 * 公共 lib 单元测试：日期区间 + 预算进度
 */
import { describe, it, expect } from 'vitest'
import { monthRange, prevMonthRange, toDateStr, dateOffset, today } from '../../src/lib/date.js'
import { budgetProgress, budgetStatus, spentPercent, WARN_PERCENT, OVER_PERCENT } from '../../src/lib/budget.js'

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
