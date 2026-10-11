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
 * 实测两者一致：HKD→CNY 腾讯 0.8525 / ECB 0.8527；USD→CNY 6.6925 / ECB 6.6921。
 *
 * ## 每个币种都带自己的来源
 *
 * 以前只回一个汇总 `source`，而「主源覆盖一部分、剩下用兜底补」这种情况会被
 * 报成 `'tencent'` —— 用户看到的是腾讯的数字，库里的 `source` 也写着腾讯，
 * 但其中几条其实来自 ECB。现在 `rows` 里**每个币种**各自带 `source` 与
 * `quoteDate`（腾讯用行情自带时间戳，ECB 用数据源自己的 `date`），
 * 汇总值只在**真的只有一个来源**时才这么叫，否则是 `'mixed'`。
 */

import { fetchQuotes, fxCodesFor, type Quote } from './quotes.js'

/** 我们关心的币种（对人民币） */
const SUPPORTED = ['HKD', 'USD', 'EUR', 'GBP', 'JPY']

/**
 * 兜底源（ECB）的超时。**对外暴露只为守护一个下界**：
 * 后台补汇率的冷却窗口必须长于「主源 + 兜底源」串起来的最坏耗时，
 * 否则窗口在上一次请求还没回来时就开了，闸门等于不存在。见 `quote-acquisition`。
 */
export const ECB_TIMEOUT_MS = 8000

/** 汇率行的来源。落进 `investment_quotes.source`，别再一律写 'tencent' */
export type FxSource = 'tencent' | 'ecb'

/** 一个币种的汇率 + 它自己的来源与日期 */
export interface FxRate {
  currency: string
  /** 1 单位该币种等于多少人民币 */
  rate: number
  source: FxSource
  /** 数据自带日期。拿不到才用今天——伪造新鲜度会让净值曲线上出现假平线 */
  quoteDate: string
  quoteAt: string
}

export interface FxResult {
  /** 币种 → 1 单位该币种等于多少人民币 */
  rates: Map<string, number>
  /** 数据来自哪个源，便于排查。**部分来自兜底时是 `'mixed'`** */
  source: 'tencent' | 'ecb' | 'mixed' | 'none'
  /** 逐币种的来源与日期；落库与汇报都用它，不要再看汇总值 */
  rows: FxRate[]
  /** 要了哪些币种（去重、只保留支持的） */
  requested: string[]
  /** 要了但没拿到的币种——调用方据此显示「待补汇率」，而不是编一个数 */
  missing: string[]
  /**
   * 两个源各自的失败原因（原文）。
   * 汇率失败不抛错，所以**这是它唯一的诊断线索**——
   * 上游改格式/限流时，日志里那一行是唯一能查的东西。
   */
  errors: string[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 主源：腾讯。返回能解析出来的部分（可能为空） */
async function fromTencent(currencies: string[]): Promise<FxRate[]> {
  const out: FxRate[] = []
  const codes = fxCodesFor(currencies)
  if (codes.length === 0) return out
  const quotes: Quote[] = await fetchQuotes(codes)
  const fallbackDate = today()
  for (const q of quotes) {
    const c = q.code.slice(2, q.code.length - 3).toUpperCase() // whHKDCNY → HKD
    if (!c) continue
    // 腾讯的时间戳是行情自带的，拿不到才退到今天（和股价同一个口径）
    const quoteDate = q.quoteDate || fallbackDate
    out.push({
      currency: c,
      rate: q.price,
      source: 'tencent',
      quoteDate,
      quoteAt: q.quoteAt || `${quoteDate} 00:00:00`,
    })
  }
  return out
}

/**
 * 兜底：frankfurter.dev（ECB）。
 * 返回的是「1 CNY = 多少外币」，要取倒数换成「1 外币 = 多少人民币」。
 * 它只有工作日更新，周末拿到的会是上一个交易日的收盘汇率——这是真实数据，
 * 不是伪造的新鲜度。所以这里**用它自己给的 `date`**，不盖今天。
 */
async function fromEcb(currencies: string[]): Promise<FxRate[]> {
  const out: FxRate[] = []
  const want = currencies.filter((c) => c !== 'CNY')
  if (want.length === 0) return out

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ECB_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=CNY&symbols=${want.join(',')}`,
      { signal: ctrl.signal },
    )
    if (!res.ok) throw new Error(`ECB 接口返回 ${res.status}`)
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> }
    // 只认 YYYY-MM-DD；别的形态宁可退回今天，也不要拿一段乱码当日期
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : today()
    for (const [ccy, perCny] of Object.entries(body.rates ?? {})) {
      if (Number.isFinite(perCny) && perCny > 0) {
        out.push({
          currency: ccy.toUpperCase(),
          rate: 1 / perCny,
          source: 'ecb',
          quoteDate: date,
          quoteAt: date,
        })
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

/**
 * 取汇率，主源失败或没覆盖到就落到兜底源。
 * 两个都拿不到就返回已拿到的部分（可能为空）——调用方据此显示「待补汇率」，
 * 而**不是**编一个数。
 *
 * 不抛错：汇率失败不该把调用方的写入搞挂，它只是一条降级事实。
 */
export async function fetchFxRates(currencies: string[]): Promise<FxResult> {
  const requested = [...new Set(currencies.map((c) => c.toUpperCase()))].filter(
    (c) => c !== 'CNY' && SUPPORTED.includes(c),
  )
  if (requested.length === 0) {
    return { rates: new Map(), source: 'none', rows: [], requested: [], missing: [], errors: [] }
  }

  const rows: FxRate[] = []
  const errors: string[] = []
  try {
    rows.push(...await fromTencent(requested))
  } catch (err) {
    errors.push(`主源: ${err instanceof Error ? err.message : String(err)}`)
    /* 主源挂了，走兜底 */
  }
  const got = new Set(rows.map((r) => r.currency))
  const missing = requested.filter((c) => !got.has(c))
  if (missing.length > 0) {
    try {
      rows.push(...await fromEcb(missing))
    } catch (err) {
      errors.push(`兜底源: ${err instanceof Error ? err.message : String(err)}`)
      /* 兜底也挂了：保留主源已拿到的部分 */
    }
  }

  const rates = new Map(rows.map((r) => [r.currency, r.rate]))
  const sources = new Set(rows.map((r) => r.source))
  return {
    rates,
    source: rows.length === 0
      ? 'none'
      : sources.size > 1 ? 'mixed' : rows[0]!.source,
    rows,
    requested,
    missing: requested.filter((c) => !rates.has(c)),
    errors,
  }
}
