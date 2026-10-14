/**
 * 分类排行（`GET /api/stats/by-category` 的读模型）
 *
 * 占比分母是**该月该类型的总额**（不是全部交易），保留一位小数。
 */
import type { getDb } from '../../db/index.js'
import { monthRange, beijingYearMonth } from '../date.js'

type Db = ReturnType<typeof getDb>

export interface ByCategoryQuery {
  year?: string
  month?: string
  type?: string
}

export interface ByCategoryResult {
  items: Array<{ id: number; name: string; icon: string; total: number; count: number; percent: number }>
  total: number
  year: number
  month: number
  type: string
}

export function buildByCategory(
  db: Db,
  userId: number,
  query: ByCategoryQuery,
): ByCategoryResult {
  const bj = beijingYearMonth()
  const year = parseInt(query.year || String(bj.year), 10)
  const month = parseInt(query.month || String(bj.month), 10)
  const type = query.type || 'expense'

  const { start: startDate, end: endDate } = monthRange(year, month)

  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.icon, SUM(t.amount) as total, COUNT(*) as count
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
          AND t.type = ?
          AND t.date BETWEEN ? AND ?
        GROUP BY t.category_id
        ORDER BY total DESC`,
    )
    .all(userId, type, startDate, endDate) as Array<{
    id: number
    name: string
    icon: string
    total: number
    count: number
  }>

  // 计算总额和占比
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0)
  const items = rows.map((r) => ({
    ...r,
    percent: grandTotal ? Math.round((r.total / grandTotal) * 1000) / 10 : 0,
  }))

  return { items, total: grandTotal, year, month, type }
}
