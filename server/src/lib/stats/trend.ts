/**
 * 日/月趋势（`GET /api/stats/trend` 的读模型）
 *
 * 两条分支的返回形状不同（月度没有 `year`/`month`，日度有）——这**是契约**，
 * 所以这里保留成 union，由路由原样下发，不统一形状。
 */
import type { getDb } from '../../db/index.js'
import { monthRange, beijingYearMonth } from '../date.js'

type Db = ReturnType<typeof getDb>

export interface TrendQuery {
  year?: string
  month?: string
  /** 'daily' | 'monthly' */
  period?: string
  type?: string
}

type MonthlyItems = Array<{ month: string; total: number; count: number }>
type DailyItems = Array<{ date: string; total: number; count: number }>

export type TrendData =
  | { items: MonthlyItems; period: string; type: string }
  | { items: DailyItems; period: string; type: string; year: number; month: number }

export function buildTrend(db: Db, userId: number, query: TrendQuery): TrendData {
  const type = query.type || 'expense'
  const period = query.period || 'daily'

  if (period === 'monthly') {
    // 月度趋势：固定最近 12 个月。
    // ⚠️ 忽略 `year` 参数：原先 `year=2020` 会把窗口放宽到二十多年，
    // 与 API.md §7「最近 12 个月」矛盾。窗口起点只由当前年月决定。
    const bjm = beijingYearMonth()

    const rows = db
      .prepare(
        `SELECT
            substr(date, 1, 7) as month,
            SUM(amount) as total,
            COUNT(*) as count
           FROM transactions
          WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
            AND type = ?
            AND date >= ?
          GROUP BY substr(date, 1, 7)
          ORDER BY month ASC`,
      )
      .all(
        userId,
        type,
        `${bjm.year - 1}-${String(bjm.month).padStart(2, '0')}-01`,
      ) as MonthlyItems

    return { items: rows, period, type }
  }

  // 日趋势：指定月份每日数据
  const bj = beijingYearMonth()
  const year = parseInt(query.year || String(bj.year), 10)
  const month = parseInt(query.month || String(bj.month), 10)
  const { start: startDate, end: endDate } = monthRange(year, month)
  const lastDay = Number(endDate.slice(8))

  const rows = db
    .prepare(
      `SELECT date, SUM(amount) as total, COUNT(*) as count
         FROM transactions
        WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
          AND type = ?
          AND date BETWEEN ? AND ?
        GROUP BY date
        ORDER BY date ASC`,
    )
    .all(userId, type, startDate, endDate) as DailyItems

  // 补全空白日期
  const filled: DailyItems = []
  const dataMap = new Map(rows.map((r) => [r.date, r]))
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    filled.push(dataMap.get(dateStr) || { date: dateStr, total: 0, count: 0 })
  }

  return { items: filled, period, type, year, month }
}
