/**
 * 持仓的数据库读取
 *
 * 为什么单独一层：`lib/holdings.ts` 是纯函数（估值逻辑，可脱离 DB 单测），
 * 这里负责「从库里读出行 + 各自最新一条行情」。两个路由
 * （`/api/assets/portfolio` 与 `/api/investments`）都需要同一份数据，
 * 之前各写了一遍，容易漂移。
 */
import type { getDb } from '../db/index.js'
import { marketOfCode } from './quotes.js'
import { groupByAccount, valueHolding, type AccountHoldings, type Holding, type HoldingValuation, type QuoteLite } from './holdings.js'

type Db = ReturnType<typeof getDb>
export type { Db }

interface InvestmentRow {
  id: number
  account_id: number
  code: string
  name: string | null
  kind: string
  quantity: number
  note: string | null
  is_active: number
  updated_at: string
}

function toHolding(r: InvestmentRow): Holding {
  return {
    id: r.id,
    accountId: r.account_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    quantity: r.quantity,
    note: r.note,
    isActive: r.is_active === 1,
    updatedAt: r.updated_at,
  }
}

/** 当前用户的全部持仓（含未启用，由调用方过滤） */
export function loadHoldings(db: Db, userId: number): Holding[] {
  const rows = db.prepare(
    `SELECT id, account_id, code, name, kind, quantity, note, is_active, updated_at
       FROM investments
      WHERE user_id = ?
      ORDER BY account_id, id`,
  ).all(userId) as InvestmentRow[]
  return rows.map(toHolding)
}

/** 每个代码的最新一条行情。取不到就不放进 Map（调用方据此把市值置 null） */
export function loadLatestQuotes(db: Db, codes: string[]): Map<string, QuoteLite> {
  const map = new Map<string, QuoteLite>()
  if (codes.length === 0) return map
  const stmt = db.prepare(
    `SELECT code, name, price, change_rate, quote_date, quoted_at
       FROM investment_quotes
      WHERE code = ?
      ORDER BY quote_date DESC, quoted_at DESC
      LIMIT 1`,
  )
  for (const code of [...new Set(codes)]) {
    const q = stmt.get(code) as
      | { code: string; name: string | null; price: number; change_rate: number | null; quote_date: string; quoted_at: string }
      | undefined
    if (q) {
      map.set(code, {
        code: q.code,
        name: q.name,
        price: q.price,
        quoteDate: q.quote_date,
        quotedAt: q.quoted_at,
        changeRate: q.change_rate,
      })
    }
  }
  return map
}

/** 按账户分组的持仓估值 —— 喂给 buildPortfolio 的第 4 个参数 */
/**
 * 把行情落库。**三处共用**（定时抓取 / 手动刷新 / 新增持仓后自动取）——
 * 之前各写各的 SQL，口径会悄悄漂移。
 *
 * `source` 落在**每一条**而不是整批一个值：兜底源拿到的汇率和腾讯拿到的汇率
 * 可能同时进这张表（主源只覆盖部分币种时）。以前这里写死 `'tencent'`，
 * 于是 ECB 补的汇率在库里也标成腾讯——事后根本分不出这条数是哪来的。
 * 未传时仍默认 `'tencent'`（历史兼容：直接写库的测试/迁移路径不受影响）。
 *
 * @returns **实际写进去的行数**（被 UNIQUE 去重掉的不算）。旧调用方忽略返回值即可。
 */
export function storeQuotes(db: Db, quotes: Array<{
  code: string; name: string | null; price: number; prevClose: number | null
  changeRate: number | null; quoteDate: string; quoteAt: string
  source?: string
}>): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO investment_quotes
       (code, name, price, prev_close, change_rate, quote_date, quoted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let written = 0
  db.transaction(() => {
    for (const q of quotes) {
      written += stmt.run(
        q.code, q.name, q.price, q.prevClose, q.changeRate, q.quoteDate, q.quoteAt,
        q.source ?? 'tencent',
      ).changes
    }
  })()
  return written
}

/**
 * 取最新汇率（币种 → 人民币）。
 *
 * 汇率也存在 `investment_quotes`（代码 `whHKDCNY` / `whUSDCNY`），
 * 和股价走同一条抓取链路，不另起一套口径。
 */
export function loadLatestFxRates(db: Db): Map<string, number> {
  const out = new Map<string, number>()
  const rows = db.prepare(
    `SELECT code, price FROM investment_quotes
      WHERE code LIKE 'wh%CNY'
      ORDER BY quote_date DESC, quoted_at DESC`,
  ).all() as Array<{ code: string; price: number }>
  for (const r of rows) {
    const ccy = r.code.slice(2, r.code.length - 3) // whHKDCNY → HKD
    if (ccy && !out.has(ccy)) out.set(ccy, r.price)
  }
  return out
}

/**
 * 行情状态：这批持仓**最后一次拿到价是什么时候**。
 *
 * 为什么要从数据里算，而不是让前端记：用户打开页面就该看到「上次更新 X」，
 * 而不是只有点过刷新才知道。前端 ref 只在手动刷新时赋值 → 页面加载时永远是空的，
 * 显示成「行情未获取过」，而实际上库里早有数据。
 */
export function loadQuoteStatus(db: Db, userId: number): {
  lastAt: string | null
  lastDate: string | null
  pricedCount: number
  totalCount: number
  /** 该用户实际持有的市场（A股/港股/美股），前端据此解释「为什么没自动更新」 */
  markets: Array<'cn' | 'hk' | 'us'>
} {
  const holdings = loadHoldings(db, userId).filter((h) => h.isActive)
  if (holdings.length === 0) {
    return { lastAt: null, lastDate: null, pricedCount: 0, totalCount: 0, markets: [] }
  }
  const codes = [...new Set(holdings.map((h) => h.code))]
  const placeholders = codes.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT MAX(quoted_at) AS last_at, MAX(quote_date) AS last_date
       FROM investment_quotes
      WHERE code IN (${placeholders})`,
  ).get(...codes) as { last_at: string | null; last_date: string | null } | undefined

  // 有多少个标的真的取到了价（用于「2/3 个已取价」这类口径）
  const priced = db.prepare(
    `SELECT count(DISTINCT code) c FROM investment_quotes WHERE code IN (${placeholders})`,
  ).get(...codes) as { c: number }

  const markets = [...new Set(holdings.map((h) => marketOfCode(h.code)))]
  return {
    lastAt: row?.last_at ?? null,
    lastDate: row?.last_date ?? null,
    pricedCount: priced.c,
    totalCount: codes.length,
    markets,
  }
}

export function loadAccountHoldings(db: Db, userId: number): Map<number, AccountHoldings> {
  const holdings = loadHoldings(db, userId).filter((h) => h.isActive)
  const quotes = loadLatestQuotes(db, holdings.map((h) => h.code))
  return groupByAccount(holdings, quotes, loadLatestFxRates(db))
}

/** 逐条估值（投资页用：要展示每条持仓的市值/现价） */
export function loadValuedHoldings(db: Db, userId: number): HoldingValuation[] {
  const holdings = loadHoldings(db, userId).filter((h) => h.isActive)
  const quotes = loadLatestQuotes(db, holdings.map((h) => h.code))
  const fx = loadLatestFxRates(db)
  return holdings.map((h) => valueHolding(h, quotes, fx))
}
