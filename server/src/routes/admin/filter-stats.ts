/**
 * 客户端拦截计数 vs 服务端入站拦截原因（契约 §4）。纯读、不写任何计数。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from '../../db/index.js'
import { loadFilterStats } from '../../lib/filter-report.js'

export async function adminFilterStatsRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/filter-stats —— 客户端拦截计数 vs 服务端入站拦截原因（契约 §4）
  //
  // ⚠️ 只含**计数**，不含任何用户内容（raw_input 才是敏感的）；跨用户聚合不写审计日志。
  // 不回「误杀率」——那要靠语料 `expect_txn` 才能判，用计数相减算出来的是编的。
  app.get('/api/admin/filter-stats', async (request: FastifyRequest) => {
    const { days } = request.query as { days?: string }
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 365)
    return { code: 0, data: loadFilterStats(getDb(), null, rangeDays), message: '' }
  })
}
