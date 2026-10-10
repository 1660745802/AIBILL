/**
 * 金额格式化（后端一律以「分」为单位，见 docs/API.md §0.4）
 *
 * 原来 11 个 .vue 文件各自复制了一份 `(cents / 100).toFixed(2)`，
 * 收拢到这里，同时把「分 ↔ 元」的换算命名，避免某处漏乘/漏除 100。
 *
 * 所有出口都先过 num()：接口少给一个字段时，页面上不应该出现
 * 「¥NaN.」这种东西——宁显示 0，也不要给一个假装是金额的字符串。
 */

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 分 → "¥ 金额" 字符串（两位小数） */
export function formatAmount(cents: number): string {
  return (num(cents) / 100).toFixed(2)
}

/** 分 → 带千分位的金额文本（不含 ¥） */
export function formatYuan(cents: number): string {
  return (Math.abs(num(cents)) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 分 → 紧凑写法（亿 / 万 / k），用于大数字展示 */
export function formatCompact(cents: number): string {
  const yuan = Math.abs(num(cents)) / 100
  if (yuan >= 100000000) return `${(yuan / 100000000).toFixed(2)}亿`
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(2)}万`
  if (yuan >= 1000) return `${(yuan / 1000).toFixed(1)}k`
  return yuan.toFixed(0)
}

/** 分 → 元（number） */
export function centsToYuan(cents: number): number {
  return num(cents) / 100
}

/** 元 → 分（四舍五入取整） */
export function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100)
}
