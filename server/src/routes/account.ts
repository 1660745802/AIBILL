/**
 * 账户路由 - /api/accounts
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const createAccountSchema = z.object({
  name: z.string().min(1, '账户名称不能为空').max(20, '账户名称最多20个字符'),
  type: z
    .enum(['cash', 'wechat', 'alipay', 'bank', 'credit', 'other'])
    .optional()
    .default('other'),
  icon: z.string().max(10).optional(),
  initial_balance: z.number().int().optional().default(0),
  sort_order: z.number().int().min(0).optional(),
})

const updateAccountSchema = z.object({
  name: z.string().min(1).max(20).optional(),
  type: z.enum(['cash', 'wechat', 'alipay', 'bank', 'credit', 'other']).optional(),
  icon: z.string().max(10).optional(),
  initial_balance: z.number().int().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.number().int().min(0).max(1).optional(),
})

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/accounts - 获取账户列表（含计算余额）
  app.get('/api/accounts', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const query = request.query as { include_inactive?: string }
    let whereClause = 'a.user_id = ?'
    if (query.include_inactive !== '1') {
      whereClause += ' AND a.is_active = 1'
    }

    const accounts = db
      .prepare(
        `SELECT
          a.*,
          a.initial_balance
            + COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = a.user_id AND type = 'income' AND account_id = a.id AND status = 'confirmed' AND deleted_at IS NULL), 0)
            - COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = a.user_id AND type = 'expense' AND account_id = a.id AND status = 'confirmed' AND deleted_at IS NULL), 0)
            + COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = a.user_id AND type = 'transfer' AND target_account_id = a.id AND status = 'confirmed' AND deleted_at IS NULL), 0)
            - COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = a.user_id AND type = 'transfer' AND account_id = a.id AND status = 'confirmed' AND deleted_at IS NULL), 0)
          AS current_balance
        FROM accounts a
        WHERE ${whereClause}
        ORDER BY a.sort_order ASC, a.id ASC`,
      )
      .all(userId)

    return { code: 0, data: { items: accounts }, message: '' }
  })

  // POST /api/accounts - 创建账户
  app.post('/api/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createAccountSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const result = db
        .prepare(
          `INSERT INTO accounts (user_id, name, type, icon, initial_balance, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, body.name, body.type, body.icon || '💳', body.initial_balance, body.sort_order || 0)

      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid)
      return { code: 0, data: account, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if ((err as any)?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        reply.code(400)
        return { code: 3001, data: null, message: '账户名称已存在' }
      }
      throw err
    }
  })

  // PUT /api/accounts/:id - 修改账户
  app.put('/api/accounts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateAccountSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const existing = db
        .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
        .get(Number(id), userId)
      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '账户不存在' }
      }

      const updates: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) { updates.push('name = ?'); params.push(body.name) }
      if (body.type !== undefined) { updates.push('type = ?'); params.push(body.type) }
      if (body.icon !== undefined) { updates.push('icon = ?'); params.push(body.icon) }
      if (body.initial_balance !== undefined) { updates.push('initial_balance = ?'); params.push(body.initial_balance) }
      if (body.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(body.sort_order) }
      if (body.is_active !== undefined) { updates.push('is_active = ?'); params.push(body.is_active) }

      if (updates.length === 0) {
        reply.code(400)
        return { code: 2000, data: null, message: '没有需要更新的字段' }
      }

      params.push(Number(id), userId)
      db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
        ...params,
      )

      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id))
      return { code: 0, data: account, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/accounts/:id - 停用账户
  app.delete('/api/accounts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('UPDATE accounts SET is_active = 0 WHERE id = ? AND user_id = ?')
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '账户不存在' }
    }

    return { code: 0, data: null, message: '账户已停用' }
  })
}
