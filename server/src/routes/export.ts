/**
 * 数据导出路由 - /api/export
 * 支持 JSON 全量导出和 CSV 交易流水导出
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/export/json — 导出用户全部数据（JSON）
  app.get('/api/export/json', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb()
    const userId = request.user!.userId

    const transactions = db
      .prepare('SELECT * FROM transactions WHERE user_id = ? AND deleted = 0')
      .all(userId)

    const categories = db
      .prepare('SELECT * FROM categories WHERE user_id = ?')
      .all(userId)

    const accounts = db
      .prepare('SELECT * FROM accounts WHERE user_id = ?')
      .all(userId)

    const budgets = db
      .prepare('SELECT * FROM budgets WHERE user_id = ?')
      .all(userId)

    const data = {
      exported_at: new Date().toISOString(),
      transactions,
      categories,
      accounts,
      budgets,
    }

    const filename = `export_${formatDate(new Date())}.json`

    reply.header('Content-Type', 'application/json; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename=${filename}`)
    return data
  })

  // GET /api/export/csv — 导出交易流水 CSV
  app.get('/api/export/csv', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { start_date?: string; end_date?: string }

    let sql = `
      SELECT
        t.date,
        t.type,
        t.amount,
        c.name AS category_name,
        a.name AS account_name,
        t.description
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ? AND t.deleted = 0
    `
    const params: (string | number)[] = [userId]

    if (query.start_date) {
      sql += ' AND t.date >= ?'
      params.push(query.start_date)
    }
    if (query.end_date) {
      sql += ' AND t.date <= ?'
      params.push(query.end_date)
    }

    sql += ' ORDER BY t.date DESC, t.id DESC'

    const rows = db.prepare(sql).all(...params) as Array<{
      date: string
      type: string
      amount: number
      category_name: string | null
      account_name: string | null
      description: string | null
    }>

    const typeMap: Record<string, string> = {
      expense: '支出',
      income: '收入',
      transfer: '转账',
    }

    // CSV 内容构建
    const header = '日期,类型,金额(元),分类,账户,描述'
    const lines = rows.map((row) => {
      const date = row.date
      const type = typeMap[row.type] || row.type
      const amount = (row.amount / 100).toFixed(2)
      const category = escapeCsvField(row.category_name || '')
      const account = escapeCsvField(row.account_name || '')
      const description = escapeCsvField(row.description || '')
      return `${date},${type},${amount},${category},${account},${description}`
    })

    // BOM + UTF-8
    const bom = '\uFEFF'
    const csv = bom + header + '\n' + lines.join('\n')

    const filename = `transactions_${formatDate(new Date())}.csv`

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename=${filename}`)
    return reply.send(csv)
  })
}

/**
 * 格式化日期为 YYYYMMDD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * CSV 字段转义：包含逗号、双引号或换行时用双引号包裹
 */
function escapeCsvField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}
