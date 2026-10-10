/**
 * 行情抓取（腾讯 qt.gtimg.cn）
 *
 * 三个必须记住的事实，都是实测出来的：
 *
 * 1. **返回是 GBK**。Node 需要 full-icu（Node 22 默认带）才能 `new TextDecoder('gbk')`。
 *
 * 2. **两种格式**：
 *    - `v_sh518880="1~名称~代码~现价~..."`  A股/ETF/指数，用 `~` 分隔
 *    - `v_hf_XAU="4194.39,1.47,..."`       外盘/期货，用 `,` 分隔且字段含义完全不同
 *    混着解析会拿到垃圾数据，所以分开处理。
 *
 * 3. **必须用行情自带的时间戳，不能用"现在"**。
 *    实测同一次请求里：ETF 的时间戳是 `20261009161456`（上一个交易日收盘），
 *    伦敦金是 `2026-10-10`（当天）。非交易日跑定时任务时，用"今天"当快照日期
 *    会造出"今天价格很新鲜"的假象——净值曲线上会出现一段假的平线。
 *
 * 非官方接口：无文档无 SLA，可能改格式或封 IP。所以：
 * - 失败必须显式抛错，不静默返回空
 * - 调用方（定时任务）失败就不写快照，宁可留旧的也别写错的
 */

const ENDPOINT = 'https://qt.gtimg.cn/q='
const TIMEOUT_MS = 8000

export interface Quote {
  /** 规范化代码，小写带市场前缀，如 sh518880 / sz159937 / hf_xau */
  code: string
  name: string
  price: number
  prevClose: number | null
  changeRate: number | null
  /** 行情自带的时间，ISO 日期 YYYY-MM-DD（不是抓取时间） */
  quoteDate: string
  quoteAt: string
}

/** 把用户输入的代码规范成腾讯能认的形式 */
export function normalizeCode(input: string): string {
  const s = input.trim().toLowerCase().replace(/\s+/g, '')
  if (/^(sh|sz|bj|hk|us)\d{5,6}$/.test(s)) return s
  if (/^hf_/.test(s)) return s
  if (/^\d{6}$/.test(s)) {
    // 6 位纯数字：5 开头或 6 开头是沪市，其余深市
    if (s.startsWith('5') || s.startsWith('6') || s.startsWith('9')) return `sh${s}`
    return `sz${s}`
  }
  if (/^\d{5}$/.test(s)) return `hk${s}`
  if (/^[a-z]+$/.test(s)) return `us${s.toUpperCase()}`
  return s
}

/** 把 20261009161456 / 20261009 这样的时间戳转成 YYYY-MM-DD */
function toIsoDate(stamp: string): string | null {
  const d = stamp.slice(0, 8)
  if (!/^\d{8}$/.test(d)) return null
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
}

/** 解析 A股/ETF/指数（`~` 分隔，88 段） */
function parseTilde(code: string, body: string): Quote | null {
  const f = body.split('~')
  if (f.length < 33) return null
  const price = Number(f[3])
  if (!Number.isFinite(price) || price <= 0) return null
  const quoteDate = toIsoDate(f[30] ?? '')
  if (!quoteDate) return null
  const prev = Number(f[4])
  return {
    code,
    name: (f[1] || '').trim(),
    price,
    prevClose: Number.isFinite(prev) && prev > 0 ? prev : null,
    changeRate: Number.isFinite(Number(f[32])) ? Number(f[32]) : null,
    quoteDate,
    quoteAt: (f[30] ?? '').length >= 14 ? f[30]! : quoteDate,
  }
}

/**
 * 解析外盘/期货（`,` 分隔）。
 * hf_ 前缀：现价,涨跌幅,买价,卖价,最高,最低,时间,昨收,... 字段位置与 A股不同。
 * 只取「现价 / 时间 / 名称」三样，涨跌幅交给调用方从价格差算，避免写死错位的下标。
 */
function parseComma(code: string, body: string): Quote | null {
  const f = body.split(',')
  if (f.length < 10) return null
  const price = Number(f[0])
  if (!Number.isFinite(price) || price <= 0) return null
  // 日期字段在不同品种里位置不同，反着找第一个像日期的段
  const dateField = f.find((x) => /^\d{4}-?\d{2}-?\d{2}$/.test(x.trim()))
  if (!dateField) return null
  const quoteDate = toIsoDate(dateField.replace(/-/g, ''))
  if (!quoteDate) return null
  const prev = Number(f[7])
  const time = (f[6] || '').trim()
  const nameField = f.find((x) => /[一-龥]/.test(x))
  return {
    code,
    name: (nameField || code).trim(),
    price,
    prevClose: Number.isFinite(prev) && prev > 0 ? prev : null,
    changeRate: Number.isFinite(prev) && prev > 0 ? ((price - prev) / prev) * 100 : null,
    quoteDate,
    quoteAt: time ? `${quoteDate} ${time}` : quoteDate,
  }
}

export function parseQuoteLine(line: string): Quote | null {
  const m = line.match(/^v_([a-z0-9_]+)="([^"]*)"/i)
  if (!m) return null
  const code = m[1]!.toLowerCase()
  const body = m[2]!
  if (body.includes('~')) return parseTilde(code, body)
  if (body.includes(',')) return parseComma(code, body)
  return null
}

/** 从一段完整响应里解析出全部行情 */
export function parseQuoteResponse(text: string): Quote[] {
  const out: Quote[] = []
  for (const line of text.split('\n')) {
    const q = parseQuoteLine(line.trim())
    if (q) out.push(q)
  }
  return out
}

/**
 * 批量取价。一次请求拿全部标的——实测 `q=sh518880,sz159937,sh000300` 三个都回来了。
 * 失败显式抛错：调用方要靠这个决定「不写快照」，静默返回空会造出假数据。
 */
export async function fetchQuotes(codes: string[]): Promise<Quote[]> {
  const list = [...new Set(codes.map(normalizeCode).filter(Boolean))]
  if (list.length === 0) return []

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT + list.join(','), {
      signal: ctrl.signal,
      headers: { Referer: 'https://gu.qq.com/' },
    })
    if (!res.ok) throw new Error(`行情接口返回 ${res.status}`)
    const buf = await res.arrayBuffer()
    let text: string
    try {
      text = new TextDecoder('gbk').decode(buf)
    } catch {
      text = new TextDecoder('utf-8').decode(buf)   // 没有 full-icu 时退回，别整个挂掉
    }
    const quotes = parseQuoteResponse(text)
    if (quotes.length === 0) throw new Error('行情接口返回空（可能改格式了或被限流）')
    return quotes
  } finally {
    clearTimeout(timer)
  }
}
