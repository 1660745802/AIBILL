/**
 * 公共 lib 单元测试：日期区间 + 预算进度
 */
import { describe, it, expect } from 'vitest'
import { monthRange, prevMonthRange, toDateStr, dateOffset, today, beijingNow, monthOffset, monthOffsetFrom, addDaysTo } from '../../src/lib/date.js'
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

  it('toDateStr / today / dateOffset 应输出合法 YYYY-MM-DD（北京时间）', () => {
    // 用显式 UTC 瞬时而不是 `new Date(y, m, d)`（后者按本地时区解析，
    // 会让断言变成「取决于部署机时区」）
    expect(toDateStr(new Date(Date.UTC(2026, 0, 4, 16, 0)))).toBe('2026-01-05') // 北京 2026-01-05 00:00
    expect(toDateStr(new Date(Date.UTC(2026, 0, 4, 15, 59)))).toBe('2026-01-04') // 北京 2026-01-04 23:59
    expect(toDateStr(new Date(Date.UTC(2025, 11, 31, 16, 0)))).toBe('2026-01-01') // 北京元旦
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dateOffset(0)).toBe(today())
    expect(dateOffset(-6) <= today()).toBe(true)
    // 连续 7 天
    const week = Array.from({ length: 7 }, (_, i) => dateOffset(-6 + i))
    expect(new Set(week).size).toBe(7)
  })

  it('D2：北京 00:00–08:00 之前，UTC 日期是「昨天」而 toDateStr 给「今天」', () => {
    // 2026-01-04 17:30 UTC = 北京 2026-01-05 01:30
    const beijingEarlyMorning = new Date(Date.UTC(2026, 0, 4, 17, 30))
    // 同一瞬时的 UTC 日期串
    expect(beijingEarlyMorning.toISOString().slice(0, 10)).toBe('2026-01-04')
    // 但北京时间是 1月5日 —— 这就是 D2 要消灭的「差一天」
    expect(toDateStr(beijingEarlyMorning)).toBe('2026-01-05')
  })

  it('beijingNow 的星期与分钟按北京时间', () => {
    // 2026-01-04 17:30 UTC = 北京 2026-01-05 01:30（周一 01:30）
    const n = beijingNow(new Date(Date.UTC(2026, 0, 4, 17, 30)))
    expect(n.mins).toBe(90)
    // 2026-01-04 是周日，UTC；北京已是周一
    expect(n.day).toBe(1)
  })

  it('monthOffsetFrom 月末钳位，不溢出到下个月（审查 MAJOR-B/C）', () => {
    // `Date.UTC(y, m+n, 31)` 会把「1月31日+1月」归一化成 3月3日；必须钳到月末。
    expect(monthOffsetFrom('2026-01-31', 1)).toBe('2026-02-28') // 平年2月
    expect(monthOffsetFrom('2024-01-31', 1)).toBe('2024-02-29') // 闰年2月
    expect(monthOffsetFrom('2026-10-31', 1)).toBe('2026-11-30')
    expect(monthOffsetFrom('2026-12-31', 1)).toBe('2027-01-31') // 跨年
    expect(monthOffsetFrom('2026-01-31', -1)).toBe('2025-12-31') // 跨年向前
    expect(monthOffsetFrom('2026-01-31', 3)).toBe('2026-04-30')
    expect(monthOffsetFrom('2026-03-15', 12)).toBe('2027-03-15') // 不涉及月末
  })

  it('monthOffsetFrom 迭代推进不会逐月漂移（订阅付款日）', () => {
    // 原 `Date.setMonth` 对月末起始日会溢出且逐月累加、永不收敛。
    let next = '2026-01-31'
    for (let i = 0; i < 12; i++) next = monthOffsetFrom(next, 1)
    expect(next).toBe('2027-01-28') // 12 个月后回到同一天（每月钳到月末）
    expect(monthOffset(1)).toBe(monthOffsetFrom(today(), 1))
  })

  it('addDaysTo 以**给定日期**为基准偏移（跨月/跨年/负数）', () => {
    expect(addDaysTo('2026-10-12', 0)).toBe('2026-10-12')
    expect(addDaysTo('2026-10-12', -6)).toBe('2026-10-06')
    expect(addDaysTo('2026-11-02', -6)).toBe('2026-10-27') // 跨月
    expect(addDaysTo('2027-01-02', -6)).toBe('2026-12-27') // 跨年
    expect(addDaysTo('2026-10-12', 7)).toBe('2026-10-19')
    // 非法串不抛：退回「相对今天」的 dateOffset（保持与 dateOffset 同语义）
    expect(addDaysTo('不是日期', 0)).toBe(dateOffset(0))
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
