/**
 * 汇率获取：主源 + 兜底源。
 *
 * 为什么要有兜底：腾讯 `qt.gtimg.cn` 是**非官方**接口，格式和可用性都不保证。
 * 这一轮已经踩过一次——`normalizeCode` 把 `whHKDCNY` 当成美股代码改成了
 * `usWHHKDCNY`，整条汇率链路静默失效，界面一直显示「待补汇率」。
 * 汇率缺失会让所有外币持仓算不出人民币市值，所以它比股价更值得有个后备。
 *
 *   主源：腾讯 `whHKDCNY`（和股价同一个接口，已经打通）
 *   兜底：frankfurter.dev（ECB 官方数据，免费无需 key，日更）
 *
 * 实测两者一致：HKD→CNY 腾讯 0.8525 / ECB 0.8527；USD→CNY 6.6925 / 6.6921。
 */

import { fetchQuotes, fxCodesFor, normalizeCode, type Quote } from './quotes.js'

/** 我们关心的币种（对人民币） */
const SUPPORTED = ['HKD', 'USD', 'EUR', 'GBP', 'JPY']

export interface FxResult {
  /** 币种 → 1 单位该币种等于多少人民币 */
  rates: Map<string, number>
  /** 数据来自哪个源，便于排查 */
  source: 'tencent' | 'ecb' | 'none'
}

/** 主源：腾讯。返回能解析出来的部分（可能为空） */
async function fromTencent(currencies: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const codes = fxCodesFor(currencies)
  if (codes.length === 0) return out
  const quotes: Quote[] = await fetchQuotes(codes)
  for (const q of quotes) {
    const c = q.code.slice(2, q.code.length - 3).toUpperCase() // whHKDCNY → HKD
    if (c) out.set(c, q.price)
  }
  return out
}

/**
 * 兜底：frankfurter.dev（ECB）。
 * 返回的是「1 CNY = 多少外币」，要取倒数换成「1 外币 = 多少人民币」。
 * 它只有工作日更新，周末拿到的会是上一个交易日的收盘汇率——这是真实数据，
 * 不是伪造的新鲜度。
 */
async function fromEcb(currencies: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const want = currencies.filter((c) => c !== 'CNY')
  if (want.length === 0) return out

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=CNY&symbols=${want.join(',')}`,
      { signal: ctrl.signal },
    )
    if (!res.ok) throw new Error(`ECB 接口返回 ${res.status}`)
    const body = (await res.json()) as { rates?: Record<string, number> }
    for (const [ccy, perCny] of Object.entries(body.rates ?? {})) {
      if (Number.isFinite(perCny) && perCny > 0) out.set(ccy, 1 / perCny)
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

/**
 * 取汇率，主源失败或没覆盖到就落到兜底源。
 * 两个都拿不到就返回已拿到的部分（可能为空 Map）——调用方据此显示「待补汇率」，
 * 而**不是**编一个数。
 */
export async function fetchFxRates(currencies: string[]): Promise<FxResult> {
  const want = [...new Set(currencies.map((c) => c.toUpperCase()))].filter(
    (c) => c !== 'CNY' && SUPPORTED.includes(c),
  )
  if (want.length === 0) return { rates: new Map(), source: 'none' }

  // 主源
  try {
    const rates = await fromTencent(want)
    if ([...want].every((c) => rates.has(c))) return { rates, source: 'tencent' }
    // 只拿到一部分 → 缺的用兜底补
    const missing = want.filter((c) => !rates.has(c))
    try {
      const fb = await fromEcb(missing)
      for (const [k, v] of fb) rates.set(k, v)
      return { rates, source: rates.size > 0 ? 'tencent' : 'none' }
    } catch {
      return { rates, source: 'tencent' }
    }
  } catch {
    /* 主源挂了，走兜底 */
  }

  try {
    return { rates: await fromEcb(want), source: 'ecb' }
  } catch {
    return { rates: new Map(), source: 'none' }
  }
}

/** 给 `investment_quotes` 落库用的腾讯格式（兜底源没有等价物，只用于腾讯） */
export function fxQuoteCode(currency: string): string {
  return normalizeCode(`wh${currency.toUpperCase()}CNY`)
}
