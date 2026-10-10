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
/**
 * 把用户/接口给的代码规范成腾讯行情接口认的形式。
 *
 * ⚠️ **大小写敏感**：已带前缀的字母代码必须保留原样。
 * 实测 `hkHSI` 通而 `hkhsi` 不通；`usAAPL` 通而 `usaapl` 不通。
 * 所以不能一上来就整串 lowerCase——那正是这些代码失效的原因。
 * 纯数字才用小写副本做匹配。
 */
export function normalizeCode(input: string): string {
  const raw = String(input).trim().replace(/\s+/g, '')
  const s = raw.toLowerCase()

  // 带点后缀：518880.sh / 00700.hk / 00700.us
  const dotted = s.match(/^([0-9a-z]+)\.(sh|sz|bj|hk|us)$/)
  if (dotted) {
    if (dotted[2] === 'us') return `us${dotted[1]!.toUpperCase()}`
    return dotted[2]! + dotted[1]!
  }

  // 已带前缀且含字母 → 保留原大小写（大小写敏感：hkHSI/usAAPL/hf_XAU）
  if (/^(hk|us|hf)[a-z]/i.test(s) && /[a-z]/i.test(raw.slice(2))) {
    const prefix = raw.slice(0, 2)
    return `${prefix === 'HK' ? 'hk' : prefix === 'US' ? 'us' : prefix === 'HF' ? 'hf' : prefix}${raw.slice(2)}`
  }
  // 已经是全小写的 hf_xxx（历史数据里存过），提到正确大小写：hf_xau → hf_XAU
  if (/^hf_[a-z]+$/.test(s)) return `hf_${s.slice(3).toUpperCase()}`
  // 已带数字前缀且已规范，别再加一次（`usAAPL` 曾被二次加前缀成 `usUSAAPL`）
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s
  if (/^hk\d{4,6}$/.test(s)) return s
  if (/^us[a-z0-9.]{1,12}$/.test(s)) return s

  // 纯数字：5 位港股、4 位是省略前导零的港股写法(0700)、6 位按首位分沪深
  if (/^\d{5}$/.test(s)) return `hk${s}`
  if (/^\d{4}$/.test(s)) return `hk0${s}`
  if (/^\d{6}$/.test(s)) return /^[569]/.test(s) ? `sh${s}` : `sz${s}`

  // 纯字母 → 美股（统一大写，腾讯只认 `usAAPL` 这种）
  if (/^[a-z.]{2,}$/.test(s)) return `us${s.toUpperCase()}`
  return s
}

/**
 * 行情时间戳 → YYYY-MM-DD。**三个市场三种写法，实测的**：
 *   A股/ETF  `20261009161456`     紧凑数字
 *   港股     `2026/10/09 16:08:14` 带斜杠和时分秒
 *   外盘     `2026-10-10`          标准日期
 * 只认其中一种，另外两个市场的数据会被**静默丢弃**（解析返回 null，
 * 上层只看到"接口返回空"）。这个坑真踩过：港股一条都进不来。
 */
function toIsoDate(stamp: string): string | null {
  const s = String(stamp).trim()
  let m = s.match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})/)   // 20261009161456 / 2026/10/09 / 2026-10-09
  if (!m) return null
  const [, y, mo, d] = m
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null
  return `${y}-${mo}-${d}`
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
  // ⚠️ **不能 lowerCase**。`holdings.ts` 用 holdings 里的 code 去查这个 Map，
  // 而 code 是 normalizeCode 的输出（`hkHSI` / `usAAPL` 保留大小写）。
  // 这里小写化会让 Map 的 key 变成 `hkhsi`，查 `hkHSI` 必然落空 →
  // 港股指数和美股永远「未取到价」。实测腾讯就是大小写敏感的。
  const code = m[1]!
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
