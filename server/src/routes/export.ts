/**
 * 数据导出路由 - /api/export
 * 支持 JSON 全量导出和 CSV 交易流水导出
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { toDateStr } from '../lib/date.js'

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/export/json — 导出用户全部数据（JSON）
  app.get('/api/export/json', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb()
    const userId = request.user!.userId

    const transactions = db
      .prepare('SELECT * FROM transactions WHERE user_id = ? AND deleted_at IS NULL')
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
      WHERE t.user_id = ? AND t.deleted_at IS NULL
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
 * 导出文件名里的日期 → YYYYMMDD。
 *
 * 用 `lib/date.ts` 的北京时间口径（与前端 `today()` 同源），不要用服务器本地时区
 * 的 `getFullYear/getMonth/getDate` —— 服务器 TZ 非 UTC 时会与前端差一天
 * （审查 MAJOR-2 / D2）。文件名是展示，但既然是「今天」就不该有两个答案。
 */
function formatDate(d: Date = new Date()): string {
  return toDateStr(d).replace(/-/g, '')
}

/**
 * 会被 Excel / Google Sheets 当公式执行的开头（CSV 公式注入 / DDE），
 * 允许前导空白（` =cmd|...` 同样会被执行），字符集取 OWASP 的
 * `=` `+` `-` `@` `\t` `\r`。
 */
const FORMULA_LEAD = /^[ \u00a0]*[=+\-@\t\r]/

/**
 * CSV 字段转义：包含逗号、双引号或换行时用双引号包裹。
 *
 * 另外先中和公式注入：描述/分类名/账户名都来自第三方账单（商户名、AI 解析的
 * 原始文本），用户导出后用 Excel 打开时，以 `=` `+` `-` `@` 开头的字段会被当
 * 公式执行（`=cmd|' /C calc'!A1` 可拉起本机程序）。加前导单引号让 Excel 按文本
 * 处理（单元格里不可见），代价是导出文本会多这个字符。
 */
function escapeCsvField(field: string): string {
  const guarded = FORMULA_LEAD.test(field) ? `'${field}` : field
  if (
    guarded.includes(',') ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r')
  ) {
    return `"${guarded.replace(/"/g, '""')}"`
  }
  return guarded
}
