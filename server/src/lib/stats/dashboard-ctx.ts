/**
 * `GET /api/stats/dashboard` 各子读模型共用的上下文。
 *
 * 「今天 / 年 / 月 / 本月起止」只算**一次**再往下传：原 handler 里这些值各自取过
 * `Date.now()`，跨北京午夜时同一个响应里会出现两个「今天」（历史上 7 天趋势的最后一个点
 * 会因此落到 SQL 窗口之外而恒显示 0）。统一下发之后，子模型不再各自取时间。
 */
import type { getDb } from '../../db/index.js'

export type Db = ReturnType<typeof getDb>

export interface DashboardCtx {
  db: Db
  userId: number
  /** 北京当前年月 */
  year: number
  month: number
  /** 北京今天的 `YYYY-MM-DD`（全 dashboard 的唯一基准） */
  today: string
  /** 本月首末日 */
  startDate: string
  endDate: string
}
