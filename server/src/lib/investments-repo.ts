/**
 * 持仓的数据库读取
 *
 * 为什么单独一层：`lib/holdings.ts` 是纯函数（估值逻辑，可脱离 DB 单测），
 * 这里负责「从库里读出行 + 各自最新一条行情」。两个路由
 * （`/api/assets/portfolio` 与 `/api/investments`）都需要同一份数据，
 * 之前各写了一遍，容易漂移。
 */
import type { getDb } from '../db/index.js'
import { groupByAccount, valueHolding, type AccountHoldings, type Holding, type HoldingValuation, type QuoteLite } from './holdings.js'

type Db = ReturnType<typeof getDb>

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
export function loadAccountHoldings(db: Db, userId: number): Map<number, AccountHoldings> {
  const holdings = loadHoldings(db, userId).filter((h) => h.isActive)
  const quotes = loadLatestQuotes(db, holdings.map((h) => h.code))
  return groupByAccount(holdings, quotes)
}

/** 逐条估值（投资页用：要展示每条持仓的市值/现价） */
export function loadValuedHoldings(db: Db, userId: number): HoldingValuation[] {
  const holdings = loadHoldings(db, userId).filter((h) => h.isActive)
  const quotes = loadLatestQuotes(db, holdings.map((h) => h.code))
  return holdings.map((h) => valueHolding(h, quotes))
}
