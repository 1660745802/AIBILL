/**
 * 日期工具 —— **「今天」只有一个定义：北京时间**。
 *
 * ## 为什么是北京时间，而不是别的
 *
 * 用户明确选定北京时间（D2 决策）。之前全仓有**三套**定义并存：
 *
 * | 定义 | 原来在哪儿 | 口径 |
 * |---|---|---|
 * | `today()` / `toDateStr()` | 本文件 | 服务器**本地时区** |
 * | `beijingDate()` / `beijingNow()` | `services/scheduler.ts` | **北京时间** |
 * | `todayStr(db)` / `toISOString().slice(0,10)` | `account-balance.ts` 与 15+ 处散落 | **UTC** |
 *
 * 北京每天 **00:00–08:00** 这 8 小时里三者会指向不同的「今天」：深夜记账时
 * 快照会被记到前一天，而月度统计算的是「今天」，曲线的翻页时刻也跟着漂。
 * 行情门禁本来就必须用北京时间（市场按北京时间开市），所以选它作唯一口径
 * 是代价最小的方向。
 *
 * ## 实现要点：不看服务器本地时区
 *
 * 一律把时刻 **+8 小时**后再用 **UTC 字段**读年月日时分。
 * 这样无论部署机是 UTC 还是 UTC+10，结果都一致——不依赖 `getTimezoneOffset()`。
 *
 * 北京时间固定 UTC+8、**不实行夏令时**，所以按 24h 整数偏移是精确的。
 */

/** 北京时间固定 UTC+8（中国不实行夏令时，无夏令时边界问题） */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 把某个时刻转成「北京墙上时间」的 Date：返回值的 **UTC 字段**就等于
 * 北京时间的年月日时分。所有取值都基于它，不再各处重复算时区。
 */
export function beijingWallClock(d: Date = new Date()): Date {
  return new Date(d.getTime() + BEIJING_OFFSET_MS)
}

/** 补零 */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → YYYY-MM-DD（**北京时间**） */
export function toDateStr(d: Date): string {
  const b = beijingWallClock(d)
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`
}

/** 今天 YYYY-MM-DD（**北京时间**） */
export function today(): string {
  return toDateStr(new Date())
}

/**
 * 今天的星期几（0 = 周日）与「当天第几分钟」，均按北京时间。
 * 行情时段门禁（A股 / 港股 / 美股的开市时段）用它。
 */
export function beijingNow(now: Date = new Date()): { day: number; mins: number } {
  const b = beijingWallClock(now)
  return {
    day: b.getUTCDay(),
    mins: b.getUTCHours() * 60 + b.getUTCMinutes(),
  }
}

/** 北京日期 YYYY-MM-DD（行情自带日期比对、判断今天是不是交易日时用） */
export const beijingDate = toDateStr

/**
 * 当前的「年 / 月」（北京时间），供月度统计默认值用。
 *
 * 不能写 `new Date().getFullYear()`——那是服务器本地时区，容器跑 UTC 时
 * 北京 00:00–08:00 会算成上一个月，整月统计的区间就整体错一个月。
 */
export function beijingYearMonth(): { year: number; month: number } {
  const b = beijingWallClock()
  return { year: b.getUTCFullYear(), month: b.getUTCMonth() + 1 }
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

/**
 * 相对今天偏移 n 天的 YYYY-MM-DD（n 可为负）。
 * 按 24h 整数推进——北京时间无夏令时，所以不存在跳变。
 */
export function dateOffset(days: number): string {
  return toDateStr(new Date(Date.now() + days * 86_400_000))
}
