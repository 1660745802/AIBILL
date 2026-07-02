/**
 * 交易路由 - /api/transactions
 * 核心业务：创建（批量+幂等）、查询（分页+筛选）、修改、软删除
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const transactionItemSchema = z.object({
  client_id: z.string().uuid().optional(),
  client_type: z.enum(['web', 'app_android', 'app_ios', 'import_script']).optional().default('web'),
  source: z
    .enum(['manual', 'ai', 'import_csv', 'app_notification', 'ocr', 'subscription'])
    .optional()
    .default('manual'),
  source_detail: z.string().optional(),
  type: z.enum(['expense', 'income', 'transfer']),
  amount: z.number().int().positive('金额必须大于0'),
  category_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().optional(),
  target_account_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD'),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, '时间格式必须为 HH:mm')
    .optional(),
  tags: z.array(z.string()).optional(),
  ai_raw_input: z.string().optional(),
  client_created_at: z.string().optional(),
})

const createTransactionsSchema = z.object({
  items: z.array(transactionItemSchema).min(1, '至少一条交易').max(50, '批量最多50条'),
})

const updateTransactionSchema = z.object({
  type: z.enum(['expense', 'income', 'transfer']).optional(),
  amount: z.number().int().positive().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  account_id: z.number().int().positive().optional(),
  target_account_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tags: z.array(z.string()).optional(),
})

interface TransactionRow {
  id: number
  user_id: number
  client_id: string | null
  [key: string]: unknown
}

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // POST /api/transactions - 批量创建（支持幂等）
  app.post('/api/transactions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createTransactionsSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const created: TransactionRow[] = []
      const duplicates: TransactionRow[] = []

      const insertStmt = db.prepare(`
        INSERT INTO transactions
          (user_id, client_id, client_type, source, source_detail, type, amount,
           category_id, account_id, target_account_id, description, date, time,
           tags, ai_raw_input, client_created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `)

      const findByClientId = db.prepare(
        'SELECT * FROM transactions WHERE user_id = ? AND client_id = ?',
      )

      const insertAll = db.transaction(() => {
        for (const item of body.items) {
          // 幂等检查
          if (item.client_id) {
            const existing = findByClientId.get(userId, item.client_id) as TransactionRow | undefined
            if (existing) {
              duplicates.push(existing)
              continue
            }
          }

          // transfer 类型校验
          if (item.type === 'transfer') {
            if (!item.target_account_id) {
              throw new ValidationError('转账类型必须指定目标账户')
            }
            // transfer 不需要分类
            item.category_id = null
          }

          // 校验 category_id 归属当前用户
          if (item.category_id) {
            const cat = db
              .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ? AND is_active = 1')
              .get(item.category_id, userId)
            if (!cat) {
              throw new ValidationError(`分类 ID ${item.category_id} 不存在或不属于当前用户`)
            }
          }

          // 校验 account_id 归属当前用户
          if (item.account_id) {
            const acc = db
              .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ? AND is_active = 1')
              .get(item.account_id, userId)
            if (!acc) {
              throw new ValidationError(`账户 ID ${item.account_id} 不存在或不属于当前用户`)
            }
          }

          // 校验 target_account_id 归属当前用户
          if (item.target_account_id) {
            const tacc = db
              .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ? AND is_active = 1')
              .get(item.target_account_id, userId)
            if (!tacc) {
              throw new ValidationError(`目标账户 ID ${item.target_account_id} 不存在或不属于当前用户`)
            }
          }

          const result = insertStmt.run(
            userId,
            item.client_id || null,
            item.client_type,
            item.source,
            item.source_detail || null,
            item.type,
            item.amount,
            item.category_id ?? null,
            item.account_id || null,
            item.target_account_id || null,
            item.description || null,
            item.date,
            item.time || null,
            JSON.stringify(item.tags || []),
            item.ai_raw_input || null,
            item.client_created_at || null,
          )

          const newRow = db
            .prepare('SELECT * FROM transactions WHERE id = ?')
            .get(result.lastInsertRowid) as TransactionRow
          created.push(newRow)
        }
      })

      insertAll()

      return { code: 0, data: { created, duplicates }, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof ValidationError) {
        reply.code(400)
        return { code: 2003, data: null, message: err.message }
      }
      throw err
    }
  })

  // GET /api/transactions - 查询流水列表
  app.get('/api/transactions', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as {
      page?: string
      page_size?: string
      start_date?: string
      end_date?: string
      type?: string
      category_id?: string
      account_id?: string
      keyword?: string
    }

    const page = Math.max(1, parseInt(query.page || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size || '20', 10)))
    const offset = (page - 1) * pageSize

    let whereClauses = ['t.user_id = ?', "t.status = 'confirmed'", 't.deleted_at IS NULL']
    const params: unknown[] = [userId]

    if (query.start_date) {
      whereClauses.push('t.date >= ?')
      params.push(query.start_date)
    }
    if (query.end_date) {
      whereClauses.push('t.date <= ?')
      params.push(query.end_date)
    }
    if (query.type) {
      whereClauses.push('t.type = ?')
      params.push(query.type)
    }
    if (query.category_id) {
      whereClauses.push('t.category_id = ?')
      params.push(Number(query.category_id))
    }
    if (query.account_id) {
      whereClauses.push('(t.account_id = ? OR t.target_account_id = ?)')
      params.push(Number(query.account_id), Number(query.account_id))
    }
    if (query.keyword) {
      whereClauses.push('t.description LIKE ?')
      params.push(`%${query.keyword}%`)
    }

    const whereStr = whereClauses.join(' AND ')

    // 总数
    const countResult = db
      .prepare(`SELECT COUNT(*) as total FROM transactions t WHERE ${whereStr}`)
      .get(...params) as { total: number }

    // 列表（关联分类和账户名称）
    const items = db
      .prepare(
        `SELECT t.*,
                c.name as category_name, c.icon as category_icon,
                a.name as account_name,
                ta.name as target_account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         LEFT JOIN accounts ta ON t.target_account_id = ta.id
         WHERE ${whereStr}
         ORDER BY t.date DESC, t.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset)

    return {
      code: 0,
      data: { items, total: countResult.total, page, page_size: pageSize },
      message: '',
    }
  })

  // GET /api/transactions/trash - 查询已删除记录
  app.get('/api/transactions/trash', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { page?: string; page_size?: string }

    const page = Math.max(1, parseInt(query.page || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size || '20', 10)))
    const offset = (page - 1) * pageSize

    const countResult = db
      .prepare(
        `SELECT COUNT(*) as total FROM transactions WHERE user_id = ? AND deleted_at IS NOT NULL`,
      )
      .get(userId) as { total: number }

    const items = db
      .prepare(
        `SELECT t.*,
                c.name as category_name, c.icon as category_icon,
                a.name as account_name,
                ta.name as target_account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         LEFT JOIN accounts ta ON t.target_account_id = ta.id
         WHERE t.user_id = ? AND t.deleted_at IS NOT NULL
         ORDER BY t.deleted_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(userId, pageSize, offset)

    return {
      code: 0,
      data: { items, total: countResult.total, page, page_size: pageSize },
      message: '',
    }
  })

  // POST /api/transactions/:id/restore - 恢复已删除记录
  app.post('/api/transactions/:id/restore', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare(
        "UPDATE transactions SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
      )
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在或未被删除' }
    }

    return { code: 0, data: null, message: '交易已恢复' }
  })

  // DELETE /api/transactions/:id/permanent - 永久删除
  app.delete('/api/transactions/:id/permanent', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare(
        'DELETE FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
      )
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在或未被删除' }
    }

    return { code: 0, data: null, message: '交易已永久删除' }
  })

  // GET /api/transactions/:id - 单条详情
  app.get('/api/transactions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const transaction = db
      .prepare(
        `SELECT t.*,
                c.name as category_name, c.icon as category_icon,
                a.name as account_name,
                ta.name as target_account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         LEFT JOIN accounts ta ON t.target_account_id = ta.id
         WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL`,
      )
      .get(Number(id), userId)

    if (!transaction) {
      reply.code(404)
      return { code: 3002, data: null, message: '交易记录不存在' }
    }

    return { code: 0, data: transaction, message: '' }
  })

  // PUT /api/transactions/:id - 修改交易
  app.put('/api/transactions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateTransactionSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const existing = db
        .prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(Number(id), userId)
      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '交易记录不存在' }
      }

      const updates: string[] = []
      const params: unknown[] = []

      if (body.type !== undefined) { updates.push('type = ?'); params.push(body.type) }
      if (body.amount !== undefined) { updates.push('amount = ?'); params.push(body.amount) }
      if (body.category_id !== undefined) { updates.push('category_id = ?'); params.push(body.category_id) }
      if (body.account_id !== undefined) { updates.push('account_id = ?'); params.push(body.account_id) }
      if (body.target_account_id !== undefined) { updates.push('target_account_id = ?'); params.push(body.target_account_id) }
      if (body.description !== undefined) { updates.push('description = ?'); params.push(body.description) }
      if (body.date !== undefined) { updates.push('date = ?'); params.push(body.date) }
      if (body.time !== undefined) { updates.push('time = ?'); params.push(body.time) }
      if (body.tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(body.tags)) }

      if (updates.length === 0) {
        reply.code(400)
        return { code: 2000, data: null, message: '没有需要更新的字段' }
      }

      // 应用层写入 updated_at
      updates.push("updated_at = datetime('now')")
      params.push(Number(id), userId)

      db.prepare(
        `UPDATE transactions SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      ).run(...params)

      const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id))
      return { code: 0, data: transaction, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/transactions/:id - 软删除
  app.delete('/api/transactions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare(
        "UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      )
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '交易记录不存在' }
    }

    return { code: 0, data: null, message: '交易已删除' }
  })
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
