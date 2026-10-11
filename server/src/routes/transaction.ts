/**
 * 交易路由 - /api/transactions
 * 核心业务：创建（批量+幂等）、查询（分页+筛选）、修改、软删除
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { matchParse, backfillLanding } from '../lib/parse-landing.js'
import { applyTxn } from '../lib/account-balance.js'

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
  // 上限 200：CSV 导入按 100 条分片提交，每片约 20KB，远低于 Fastify 默认
  // 1MB bodyLimit；再大则应走专用导入接口
  items: z.array(transactionItemSchema).min(1, '至少一条交易').max(200, '批量最多200条'),
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

          /* 账户余额跟着账单走：有归属的账单实时加减账户余额快照。
             没传 account_id 的（旧客户端 / 无归属）返回空数组，行为不变。 */
          applyTxn(db, newRow, 1, userId)

          /* ═══ 落地关联：服务端自己判断这笔是不是某次 AI 解析的结果 ═══
             不依赖客户端上报——它本来就会把 /ai/parse 返回的 items 原样 POST 过来，
             两边用 (type, amount, date) 指纹对一下就行。
             线上实测：解析→落库 P50 0.2 分钟，指纹命中率 70%，命中里 92% 唯一。
             关联成功后回填 ai_raw_input（原始通知文本）与 ai_parse_logs.final_items，
             至此「AI 抽的数到底进没进账本」变成一个可查的事实。              */
          const landed = matchParse(userId, {
            type: item.type,
            amount: item.amount,
            date: item.date,
          })
          if (landed) {
            const logRow = db
              .prepare('SELECT parsed_items FROM ai_parse_logs WHERE id = ? AND user_id = ?')
              .get(landed.logId, userId) as { parsed_items: string | null } | undefined
            let finalItems: unknown[] = []
            if (logRow?.parsed_items) {
              try { finalItems = JSON.parse(logRow.parsed_items) } catch { /* 坏 JSON 不阻塞写入 */ }
            }
            backfillLanding(Number(result.lastInsertRowid), landed.logId, landed.rawInput, finalItems)
          }
        }
      })

      insertAll()

      /* 这里曾经算一遍当月预算超支并随响应返回 budget_warnings，已删除：
         产出后全仓库无任何消费方——Web 前端不读，Android App 的
         CreateTransactionResponse 只声明 created/duplicates 两个字段（Moshi
         静默忽略多余字段），docs/API.md 也没收录它，等于从没进过契约。
         而且它本身有缺陷：预警按 created 数组里**第一笔**的月份算就break，
         一次批量若跨月，另一个月的预警会被静默丢掉。

         预算预警的活机制是 GET /api/stats/dashboard 的 alerts[]（type=
         'budget_warning'），那一套有消费方、有测试，且复用同一份 budget_progress。
         顺带省掉每次建单都要跑的两条 SQL。 */
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
      tag?: string
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
    if (query.tag) {
      // tags 字段是 JSON 数组字符串，用 LIKE 模糊匹配
      whereClauses.push('t.tags LIKE ?')
      params.push(`%"${query.tag}"%`)
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

  // GET /api/transactions/tags - 获取用户所有标签
  app.get('/api/transactions/tags', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    // 从所有交易的 tags 字段中提取去重标签
    const rows = db
      .prepare(
        `SELECT DISTINCT tags FROM transactions
         WHERE user_id = ? AND tags != '[]' AND tags IS NOT NULL
           AND status = 'confirmed' AND deleted_at IS NULL`,
      )
      .all(userId) as Array<{ tags: string }>

    const tagSet = new Set<string>()
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.tags)
        if (Array.isArray(arr)) {
          arr.forEach((t: string) => { if (t) tagSet.add(t) })
        }
      } catch { /* ignore */ }
    }

    return { code: 0, data: { items: Array.from(tagSet).sort() }, message: '' }
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

    // 恢复前先取旧值：软删时已经把余额减掉了，这里要加回去。
    // 必须**先读后写**，否则 deleted_at 一改就查不到了。
    const before = db
      .prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .get(Number(id), userId) as TransactionRow | undefined

    // 事务：UPDATE 与余额回补要么都成，要么都不做
    const ok = db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE transactions SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
        )
        .run(Number(id), userId)
      if (result.changes === 0) return false
      if (before) applyTxn(db, before, 1, userId)
      return true
    })()

    if (!ok) {
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
        .prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(Number(id), userId) as any
      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '交易记录不存在' }
      }

      /* 归属校验：POST 有，PUT 原来没有。
         漏了它 + applyTxn 不按 user 过滤 ⇒ 用户 A 可以把自己的账单指向
         用户 B 的账户，直接把 B 的余额改掉。 */
      for (const [field, label] of [['account_id', '账户'], ['target_account_id', '目标账户']] as const) {
        const val = (body as any)[field]
        if (val === undefined || val === null) continue
        const acc = db
          .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ? AND is_active = 1')
          .get(val, userId)
        if (!acc) {
          throw new ValidationError(`${label} ID ${val} 不存在或不属于当前用户`)
        }
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

      /* 余额跟着账单走：先把旧值从原账户撤回，再把新值应用到新账户。
         改金额、改类型、改归属账户都会走到这里——少一步余额就飘了。
         整段包在事务里：UPDATE 成功但 applyTxn 失败会留下「交易已改、余额没改」
         的半状态，而且没法回滚。 */
      db.transaction(() => {
        db.prepare(
          `UPDATE transactions SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        ).run(...params)
        const next = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id))
        applyTxn(db, existing, -1, userId)
        applyTxn(db, next, 1, userId)
      })()

      const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id))
      return { code: 0, data: transaction, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof ValidationError) {
        reply.code(400)
        return { code: 2001, data: null, message: err.message }
      }
      throw err
    }
  })

  // DELETE /api/transactions/:id - 软删除
  app.delete('/api/transactions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    // 软删前取旧值，删完把余额减回去。
    const before = db
      .prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(Number(id), userId) as TransactionRow | undefined

    // 事务：软删与余额回退要么都成，要么都不做
    const ok = db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .run(Number(id), userId)
      if (result.changes === 0) return false
      if (before) applyTxn(db, before, -1, userId)
      return true
    })()

    if (!ok) {
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
