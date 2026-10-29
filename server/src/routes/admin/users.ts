/**
 * 用户管理（6 端点）。删除走 `lib/admin-purge.ts` 的 `purgeUserData`：
 * 「哪些表要清、什么顺序清、哪些只置空」是那个 module 自身的性质，这里只调它。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../db/index.js'
import { adminResetPassword, newPasswordSchema } from '../../services/auth.service.js'
import { appLog } from '../../services/logger.js'
import { pageParam } from '../../lib/pagination.js'
import { purgeUserData } from '../../lib/admin-purge.js'

const updateUserSchema = z.object({
  is_active: z.number().int().min(0).max(1),
})

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/admin/users - 用户列表（不含交易数据）
  app.get('/api/admin/users', async () => {
    const db = getDb()
    const users = db
      .prepare(
        `SELECT id, username, nickname, role, is_active, created_at,
                (SELECT COUNT(*) FROM transactions WHERE user_id = users.id AND deleted_at IS NULL) as transaction_count
         FROM users
         ORDER BY created_at DESC`,
      )
      .all()
    return { code: 0, data: { items: users }, message: '' }
  })


  // PUT /api/admin/users/:id - 启用/禁用用户
  app.put('/api/admin/users/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateUserSchema.parse(request.body)
      const db = getDb()

      // 不能禁用自己
      if (Number(id) === request.user!.userId) {
        reply.code(400)
        return { code: 3003, data: null, message: '不能禁用自己的账号' }
      }

      const result = db
        .prepare(
          `UPDATE users SET is_active = ?,
           token_version = COALESCE(token_version, 0) + 1
           WHERE id = ?`,
        )
        .run(body.is_active, Number(id))

      if (result.changes === 0) {
        reply.code(404)
        return { code: 3002, data: null, message: '用户不存在' }
      }

      return { code: 0, data: null, message: body.is_active ? '用户已启用' : '用户已禁用' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })


  // GET /api/admin/users/:id/stats - 用户账单统计
  app.get('/api/admin/users/:id/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const user = db.prepare('SELECT id, username, nickname, role, is_active, created_at FROM users WHERE id = ?').get(Number(id)) as any
    if (!user) {
      reply.code(404)
      return { code: 3002, data: null, message: '用户不存在' }
    }

    /* 审计：跨用户读「他人收支总额」与明细/原文同口径（ARCHITECTURE §5.3）。
       ⚠️ 放在 404 判定**之后**：否则管理员拿垃圾 id 探测也会留 warn，且 `Number('abc')` 会得到 NaN。
       字段名用 `admin_id`，与同模块既有三条（删除/重置密码/…）保持一致。 */
    appLog('warn', 'admin', `查看用户 #${user.id} 的账单统计`, {
      admin_id: request.user!.userId,
      target_user_id: user.id,
      username: user.username,
    })

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND deleted_at IS NULL) as total_transactions,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type = 'expense' AND status = 'confirmed' AND deleted_at IS NULL) as total_expense,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type = 'income' AND status = 'confirmed' AND deleted_at IS NULL) as total_income,
        (SELECT COUNT(*) FROM categories WHERE user_id = ?) as category_count,
        (SELECT COUNT(*) FROM accounts WHERE user_id = ?) as account_count
    `).get(Number(id), Number(id), Number(id), Number(id), Number(id)) as any

    return { code: 0, data: { user, stats }, message: '' }
  })


  // GET /api/admin/users/:id/transactions - 查看用户账单明细
  app.get('/api/admin/users/:id/transactions', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const query = request.query as { page?: string; page_size?: string }
    const db = getDb()
    const userId = Number(id)

    // 审计：跨用户查看明细是**有意保留的运维能力**（README「定位与原则」），不是漏洞，
    // 但属敏感操作 → 一律按 warn 记一条（谁、看谁、什么动作）。appLog 只写库不抛错。
    appLog('warn', 'admin', `管理员查看用户流水明细: user_id=${userId}`, {
      action: 'view_user_transactions',
      admin_id: request.user!.userId,
      target_user_id: userId,
    })

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
    if (!user) {
      reply.code(404)
      return { code: 3002, data: null, message: '用户不存在' }
    }

    // 分页：非法值（`?page=abc` / `1e999`）不能变成 NaN/Infinity 绑进 LIMIT/OFFSET（否则 500）
    const page = pageParam(query.page, 1, Number.MAX_SAFE_INTEGER)
    const pageSize = pageParam(query.page_size, 20, 100)
    const offset = (page - 1) * pageSize

    const countRow = db
      .prepare('SELECT COUNT(*) as total FROM transactions WHERE user_id = ? AND deleted_at IS NULL')
      .get(userId) as { total: number }

    const items = db
      .prepare(
        `SELECT t.id, t.type, t.amount, t.description, t.date, t.source,
                c.name as category_name, c.icon as category_icon,
                a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.user_id = ? AND t.deleted_at IS NULL
         ORDER BY t.date DESC, t.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(userId, pageSize, offset)

    return { code: 0, data: { items, total: countRow.total, page, page_size: pageSize }, message: '' }
  })


  // PUT /api/admin/users/:id/reset-password - 重置用户密码
  app.put('/api/admin/users/:id/reset-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const resetSchema = z.object({ new_password: newPasswordSchema })

    try {
      const body = resetSchema.parse(request.body)
      const result = adminResetPassword(Number(id), body.new_password)
      if (!result.success) {
        reply.code(404)
        return { code: 3002, data: null, message: result.message }
      }
      return { code: 0, data: null, message: result.message }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })


  // DELETE /api/admin/users/:id - 删除用户（清除所有数据）
  app.delete('/api/admin/users/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = Number(id)

    // 不能删除自己
    if (userId === request.user!.userId) {
      reply.code(400)
      return { code: 3003, data: null, message: '不能删除自己的账号' }
    }

    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as any
    if (!user) {
      reply.code(404)
      return { code: 3002, data: null, message: '用户不存在' }
    }

    // 事务中删除用户所有数据（任一步失败则整体回滚）
    try {
      db.transaction(() => {
        purgeUserData(db, userId)
        db.prepare('DELETE FROM users WHERE id = ?').run(userId)
      })()
    } catch (err) {
      const sqliteCode = (err as { code?: string }).code
      if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) {
        // 兜底：若将来新增了带外键的表而忘记加进 USER_SCOPED_TABLES，
        // 给出可读错误而不是把 SQLITE_CONSTRAINT_* 泄漏给前端
        appLog('error', 'admin', `删除用户 ${userId} 失败：存在未清理的关联数据`, {
          user_id: userId,
          sqlite_code: sqliteCode,
        })
        reply.code(400)
        return {
          code: 2003,
          data: null,
          message: '删除失败：仍有数据关联该用户（外键约束），请检查服务端日志',
        }
      }
      throw err
    }

    return { code: 0, data: null, message: `用户 ${user.username} 已删除` }
  })
}
