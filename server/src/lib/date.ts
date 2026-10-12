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

/**
 * 从**今天（北京时间）**起偏移 n 个月的 YYYY-MM-DD（n 可为负），**钳位到目标月最后一天**。
 *
 * 用于「预计完成日期」这类推算。⚠️ 不要写成
 * `new Date(); d.setMonth(d.getMonth()+n); d.toISOString().slice(0,10)` ——
 * 那是「本地时区做加月 + UTC 格式化」的**错位组合**，服务器 TZ 非 UTC 时会差一天。
 *
 * ⚠️ 也不能直接 `Date.UTC(y, m+n, day)`：它不钳位，`Date.UTC(2026,1,31)`
 * （1月31日+1月）会归一化成 **3月3日**（溢出到下个月），约 10% 的日期会踩到
 * （审查 MAJOR-B）。必须先钳到目标月的天数。
 */
export function monthOffset(months: number): string {
  const b = beijingWallClock()
  return addMonths(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), months)
}

/**
 * 从**任意日期串**（YYYY-MM-DD）偏移 n 个月，同样钳位到月末。
 *
 * 订阅的 `next_payment_date` 推进用它（`subscription.ts` 的 calcNextPayment 与
 * `scheduler.ts` 的到期推进）——那两处原先用 `setMonth` 会溢出且漂移
 * （2026-01-31 +1 月会变成 3-03，再逐月累加，永不收敛，审查 MAJOR-C）。
 *
 * 只接受**真实存在的日期**：格式对但取值非法（如 `2026-13-01`、`2026-02-30`）
 * 不会原样传播，而是退回 `monthOffset(months)`（合法值）。
 * 不退的话非法串会被写进 `next_payment_date`，该订阅因字典序比较永远不被
 * scheduler 选中，变成一条永久失效 + 数据脏的记录（审查 MINOR-2）。
 */
export function monthOffsetFrom(dateStr: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return monthOffset(months)
  const y = Number(m[1])
  const mo0 = Number(m[2]) - 1
  const day = Number(m[3])
  if (mo0 < 0 || mo0 > 11) return monthOffset(months)
  const lastDay = new Date(Date.UTC(y, mo0 + 1, 0)).getUTCDate()
  if (day < 1 || day > lastDay) return monthOffset(months)
  return addMonths(y, mo0, day, months)
}

/**
 * 从**任意日期串**（YYYY-MM-DD）偏移 n 天（n 可为负），北京时间口径。
 *
 * 纯日期串运算：两边都按 UTC 午夜，差值恒为整数天（与 `daysUntil` 同一套口径）。
 * 需要「以某一个确定的日期为基准推几天」时用它——`dateOffset(n)` 是相对**当前时刻**的，
 * 在同一个 handler 里连调多次会各自取一次 now（跨北京午夜就错位）。
 */
export function addDaysTo(dateStr: string, days: number): string {
  const base = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(base)) return dateOffset(days)
  return toDateStr(new Date(base + days * 86_400_000))
}

/**
 * 距离某个日期还有几天（**北京时间**口径）：`0` = 今天，`1` = 明天，负数 = 已过。
 *
 * 两个都是 YYYY-MM-DD，两边都按 UTC 午夜解析 ⇒ 差值恒为整数天，
 * **不存在 8 小时错位**。不要写成
 * `Math.ceil((new Date(due).getTime() - Date.now()) / 86400000)` ——
 * 那是「UTC 午夜 vs 当前瞬时」，北京 00:00–08:00 会把「今天扣费」算成「明天」
 * （审查 MINOR-1）。
 */
export function daysUntil(dateStr: string): number {
  const due = Date.parse(`${dateStr}T00:00:00Z`)
  const base = Date.parse(`${today()}T00:00:00Z`)
  return Math.round((due - base) / 86_400_000)
}

/**
 * 年月日 + n 个月，日**钳位到目标月最后一天**（内部）。
 *
 * ⚠️ 钳位是 clamp-and-keep：`2026-01-31` +1 月 → `2026-02-28`，再 +1 月
 * → `2026-03-28`（**不回弹到 31 号**）。这是主流计费系统的标准做法，
 * 也远好于旧 `setMonth` 的持续漂移；只是原始的「31 号」意图不再保留。
 */
function addMonths(year: number, month0: number, day: number, months: number): string {
  const target = month0 + months
  const y = year + Math.floor(target / 12)
  const mo = ((target % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const d = Math.min(day, lastDay)
  return `${y}-${pad(mo + 1)}-${pad(d)}`
}
