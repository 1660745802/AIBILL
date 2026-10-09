/**
 * 日期区间工具
 *
 * 背景：原先“算某年某月的起止日”这段代码在 stats / budget / transaction
 * 三处重复了 6 遍。抽到这里后只有一份，顺带也解决了时区口径问题——
 * 全部走**本地时区**，不再混用 `toISOString()`（UTC）。
 *
 * 注意：UTC 与本地日期在东八区 00:00–08:00 会差一天，
 * 记账场景必须以用户所在时区的“今天”为准。
 */

/** 补零 */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → YYYY-MM-DD（本地时区） */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 今天 YYYY-MM-DD（本地时区） */
export function today(): string {
  return toDateStr(new Date())
}

/** 某年某月的起止日（含首尾），month 为 1–12 */
export function monthRange(year: number, month: number): { start: string; end: string } {
  const lastDay = new Date(year, month, 0).getDate()
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
  }
}

/** 上一个月的起止日（跨年正确） */
export function prevMonthRange(year: number, month: number): { start: string; end: string } {
  return month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1)
}

/** 相对今天偏移 n 天的 YYYY-MM-DD（n 可为负） */
export function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}
