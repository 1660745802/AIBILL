/**
 * 应用运行日志（`app_logs`）查看。只读、带审计。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from '../../db/index.js'
import { pageParam } from '../../lib/pagination.js'

export async function adminLogRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/logs - 应用日志查看
  app.get('/api/admin/logs', async (request: FastifyRequest) => {
    const db = getDb()
    const { level, module, page, page_size, days } = request.query as {
      level?: string
      module?: string
      page?: string
      page_size?: string
      days?: string
    }

    const pageNum = pageParam(page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(page_size, 50, 200)
    const offset = (pageNum - 1) * size

    const conditions: string[] = []
    const params: any[] = []

    if (days) {
      const rangeDays = Math.min(Math.max(Number(days), 1), 90)
      const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')
      conditions.push('created_at >= ?')
      params.push(sinceDate)
    }
    if (level && ['info', 'warn', 'error'].includes(level)) {
      conditions.push('level = ?')
      params.push(level)
    }
    if (module) {
      conditions.push('module = ?')
      params.push(module)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM app_logs ${whereClause}`)
      .get(...params) as { total: number }

    const logs = db
      .prepare(
        `SELECT * FROM app_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset)

    return {
      code: 0,
      data: {
        items: logs,
        pagination: { page: pageNum, page_size: size, total: countRow.total },
      },
      message: '',
    }
  })
}
