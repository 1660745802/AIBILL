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

/**
 * 分 → 「整数部分 / 小数部分」拆分（整数带千分位，小数恒 2 位）。
 *
 * `Money.vue` 的排版是「整数重、小数轻」，需要拆成两段而不是整串，
 * 所以拆分逻辑也必须收在这一份实现里（原先组件内自持一份）。
 * @param absolute 是否取绝对值（符号由调用方单独承担）
 */
export function formatYuanParts(cents: number, absolute = true): { int: string; frac: string } {
  const yuan = num(cents) / 100
  const magnitude = absolute ? Math.abs(yuan) : yuan
  const [int, frac] = magnitude.toFixed(2).split('.')
  return { int: Number(int).toLocaleString('zh-CN'), frac: frac ?? '00' }
}

/**
 * **仪表读数**：≥1 万不带小数（那两位在这个量级是噪声），以下保留 2 位。
 * 带 `¥` 前缀与负号（`−`）。
 *
 * ⚠️ 只用于仪表读数（UI-DESIGN §3）；流水/表单等普通金额请用 `formatYuanParts`。
 * 两套语义用一个显式函数区分，不做全局行为切换。
 */
export function formatReading(cents: number): string {
  const yuan = Math.abs(num(cents)) / 100
  const s = yuan >= 10000
    ? Math.round(yuan).toLocaleString('zh-CN')
    : yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${num(cents) < 0 ? '−' : ''}¥${s}`
}

/**
 * **仪表窄屏读数**：万 / k / 亿 缩写，不截断（UI-DESIGN §3「¥128.4万」）。
 * 同样只用于仪表读数。
 */
export function formatReadingCompact(cents: number): string {
  const yuan = Math.abs(num(cents)) / 100
  const sign = num(cents) < 0 ? '−' : ''
  if (yuan >= 100000000) return `${sign}¥${(yuan / 100000000).toFixed(2)}亿`
  if (yuan >= 10000) return `${sign}¥${(yuan / 10000).toFixed(1)}万`
  if (yuan >= 1000) return `${sign}¥${(yuan / 1000).toFixed(1)}k`
  return `${sign}¥${yuan.toFixed(0)}`
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
