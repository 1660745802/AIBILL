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