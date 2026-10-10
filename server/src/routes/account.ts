/**
 * 账户路由 - /api/accounts
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { setManualBalance } from '../lib/account-balance.js'

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
  current_balance: z.number().int().optional(), // 017 起即 accounts.balance：用户改它 = 手填修正 = 覆盖
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
          a.balance AS current_balance
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
          `INSERT INTO accounts (user_id, name, type, icon, initial_balance, balance, balance_as_of_txn_id, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId, body.name, body.type, body.icon || '💳',
          body.initial_balance,
          body.initial_balance,
          // 基准线 = 0：还没有任何流水参与过。
          // 期初余额是「从一开始就这么多」而非手动修正，所以补录的历史账单
          // （哪怕业务日期在过去）也必须能加减余额。
          0,
          body.sort_order || 0,
        )

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
      if (body.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(body.sort_order) }
      if (body.is_active !== undefined) { updates.push('is_active = ?'); params.push(body.is_active) }

      // 处理余额设置：旧客户端传 current_balance（它屏幕上显示的那个数）。
      // 017 之后它就是 `accounts.balance`——用户改它 = 手填修正 = **覆盖**。
      //
      // 旧逻辑是「目标余额 − 流水净影响 = initial_balance」，那是反向推导，
      // 会把 551 笔无归属流水的影响错算进来，而且和手填快照打架。
      if (body.current_balance !== undefined) {
        // 覆盖即刷新基准线到此刻。此刻之前就存在的账单已经烤进这个数里了。
        // 走 setManualBalance（upsert 快照）：之前这里用裸 INSERT，
        // 同一天改第二次余额会撞 UNIQUE(user_id, account_id, snapshot_date) → 500，
        // 而且它在 UPDATE 之前执行，所以余额一点没改就失败了。
        setManualBalance(db, userId, Number(id), body.current_balance)
      } else if (body.initial_balance !== undefined) {
        // 017 之后 balance 才是读取端唯一真源。**必须走 setManualBalance**：
        // 直接覆盖 balance 而不推进基准线，会把「基准线之后已生效的账单」抹掉，
        // 而那些账单之后被删除时又会被再减一次 → 永久差额。
        setManualBalance(db, userId, Number(id), body.initial_balance)
        updates.push('initial_balance = ?')
        params.push(body.initial_balance)
      }

      if (updates.length === 0 && body.current_balance === undefined) {
        reply.code(400)
        return { code: 2000, data: null, message: '没有需要更新的字段' }
      }

      // 余额已由 setManualBalance 直接落库；其余字段（名字/图标/排序…）在这里更新。
      // 两者必须能各走各的：只传 current_balance 时 updates 本来就是空的。
      if (updates.length > 0) {
        params.push(Number(id), userId)
        db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
          ...params,
        )
      }

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
