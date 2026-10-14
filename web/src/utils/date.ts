/**
 * 前端日期工具
 *
 * ## 为什么不能用 `toISOString().slice(0, 10)`
 *
 * `toISOString()` 是 **UTC**。北京时间每天 00:00–08:00 这段时间，UTC 还在「昨天」，
 * 所以：
 *   - 首页「今天的账单」会查成**昨天**的
 *   - 手动记一笔账，业务日期会被默认成**昨天**
 *   - 导出文件名带着**昨天**的日期
 *
 * 浏览器跑在**用户所在时区**，取本地年月日就是用户心里的「今天」——
 * 对国内用户即北京时间，与服务端 D2 决策（统一北京时间）一致。
 *
 * ⚠️ **有意为之，不要「修」成 UTC+8**：服务端 `lib/date.ts` 固定北京时间，
 * 而前端取浏览器本地时区。两者在**中国大陆以外**可能差一天（例：纽约用户
 * 北京时间 09:00 时，前端 `today()` 是「昨天」，而服务端 `today()` 是「今天」）。
 * 这是刻意的：前端服务于「用户自己记的那天」，比硬编码 UTC+8 更符合直觉。
 * 「今天只有一处定义」这句话**只对服务端成立**。
 */

/** Date → YYYY-MM-DD（**本地时区**） */
export function toDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天 YYYY-MM-DD（本地时区 = 用户时区） */
export function today(): string {
  return toDateStr()
}

/**
 * 服务端 UTC 时间串 → 本地 `MM-DD HH:mm`。
 *
 * 服务端时间戳是 SQLite `datetime('now')` = UTC 且**不带 `Z`**，`new Date()` 会按
 * 本机时区解释 → 差 8 小时。所以缺 `Z` 时补上；完全解析不了就退回原串的 `MM-DD HH:mm` 片段
 * （宁可显示粗糙，也不显示错的时间）。
 */
export function formatLocalTime(utcStr: string | null | undefined): string {
  if (!utcStr) return '-'
  const d = new Date(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z')
  if (isNaN(d.getTime())) return utcStr.slice(5, 16)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}`
}