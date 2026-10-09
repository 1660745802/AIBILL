/**
 * 管理员路由 - /api/admin
 * 邀请码管理、用户管理、全局设置
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { adminResetPassword } from '../services/auth.service.js'
import { appLog } from '../services/logger.js'
import crypto from 'node:crypto'

/**
 * 删除用户时需要清理的表（顺序 = 依赖倒序：先子表，后父表）
 *
 * 背景：PRAGMA foreign_keys = ON，子表被父表引用时若先删父表会抛
 * SQLITE_CONSTRAINT_FOREIGNKEY。defer_foreign_keys 也救不了——它只是把检查
 * 推迟到提交，子行依然存在。因此**唯一正确的解法是删除顺序**。
 *
 * 新增带外键的表时，务必按依赖关系插入到正确位置。
 */
const USER_SCOPED_TABLES: string[] = [
  'asset_snapshots',      // → accounts
  'recurring_patterns',   // → categories / accounts
  'subscriptions',        // → categories / accounts
  'financial_goals',      // → accounts（goal_progress 由 ON DELETE CASCADE 连带清除）
  'transactions',         // → categories / accounts
  'ai_conversations',
  'ai_parse_logs',
  'ai_memories',
  'budgets',              // → categories
  'user_settings',
  'categories',           // 父表：最后删
  'accounts',             // 父表：最后删
]

/**
 * 清除某个用户的全部业务数据（不含 users 行本身），调用方需自行控制事务。
 * @param userId 目标用户 id
 */
function purgeUserData(db: ReturnType<typeof getDb>, userId: number): void {
  for (const table of USER_SCOPED_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
  }

  // 引用 users(id) 但列可空的表：置空而不是删行
  // （邀请码 / 规则版本是全局资源，不应随创建者消失）
  db.prepare('UPDATE invite_codes SET created_by = NULL WHERE created_by = ?').run(userId)
  db.prepare('UPDATE notification_rules SET created_by = NULL WHERE created_by = ?').run(userId)
}

const createInviteCodeSchema = z.object({
  max_uses: z.number().int().min(1).max(1000).optional().default(1),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

const updateUserSchema = z.object({
  is_active: z.number().int().min(0).max(1),
})

const updateSettingsSchema = z.record(z.string(), z.string())

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)
  app.addHook('preHandler', adminMiddleware)

  // POST /api/admin/invite-codes - 生成邀请码
  app.post('/api/admin/invite-codes', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createInviteCodeSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const code = crypto.randomBytes(4).toString('hex').toUpperCase()

      db.prepare(
        'INSERT INTO invite_codes (code, max_uses, created_by, expires_at) VALUES (?, ?, ?, ?)',
      ).run(code, body.max_uses, userId, body.expires_at || null)

      const inviteCode = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code)
      return { code: 0, data: inviteCode, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // GET /api/admin/invite-codes - 邀请码列表
  app.get('/api/admin/invite-codes', async () => {
    const db = getDb()
    const codes = db
      .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
      .all()
    return { code: 0, data: { items: codes }, message: '' }
  })

  // DELETE /api/admin/invite-codes/:id - 作废邀请码
  app.delete('/api/admin/invite-codes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    // 将 max_uses 设为 used_count，使其立即失效
    const result = db
      .prepare('UPDATE invite_codes SET max_uses = used_count WHERE id = ?')
      .run(Number(id))

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '邀请码不存在' }
    }

    return { code: 0, data: null, message: '邀请码已作废' }
  })

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

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
    if (!user) {
      reply.code(404)
      return { code: 3002, data: null, message: '用户不存在' }
    }

    const page = Math.max(1, parseInt(query.page || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size || '20', 10)))
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
    const resetSchema = z.object({ new_password: z.string().min(6, '新密码至少6个字符').max(50) })

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

  // GET /api/admin/settings - 全局设置
  app.get('/api/admin/settings', async () => {
    const db = getDb()
    const rows = db.prepare('SELECT key, value, updated_at FROM settings').all() as Array<{
      key: string
      value: string
      updated_at: string
    }>

    const settings: Record<string, string> = {}
    for (const row of rows) {
      // 脱敏：API Key 只返回部分
      if (row.key === 'ai_api_key' && row.value) {
        settings[row.key] = row.value.slice(0, 8) + '***'
      } else {
        settings[row.key] = row.value
      }
    }
    return { code: 0, data: settings, message: '' }
  })

  // GET /api/admin/ai-parse-stats - AI 解析质量统计
  app.get('/api/admin/ai-parse-stats', async (request: FastifyRequest) => {
    const db = getDb()
    const { days } = request.query as { days?: string }
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 365)
    const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')

    // 总量 + 成功率 + 平均时长
    const overview = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          ROUND(AVG(duration_ms)) as avg_duration_ms
         FROM ai_parse_logs
         WHERE created_at >= ?`,
      )
      .get(sinceDate) as { total: number; success_count: number; avg_duration_ms: number | null }

    const successRate = overview.total > 0
      ? Math.round((overview.success_count / overview.total) * 10000) / 100
      : 0

    // 按状态分组
    const byStatus = db
      .prepare(
        `SELECT status, COUNT(*) as count
         FROM ai_parse_logs
         WHERE created_at >= ?
         GROUP BY status`,
      )
      .all(sinceDate) as Array<{ status: string; count: number }>

    // 最近失败记录
    const recentFailures = db
      .prepare(
        `SELECT id, user_id, raw_input, status, error_message, duration_ms, created_at
         FROM ai_parse_logs
         WHERE created_at >= ? AND status IN ('error', 'timeout')
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(sinceDate)

    // 修改率统计（用户修改 AI 结果的比例）
    const modificationStats = db
      .prepare(
        `SELECT
          COUNT(*) as total_with_feedback,
          SUM(CASE WHEN user_modified = 1 THEN 1 ELSE 0 END) as modified_count
         FROM ai_parse_logs
         WHERE created_at >= ? AND final_items IS NOT NULL`,
      )
      .get(sinceDate) as { total_with_feedback: number; modified_count: number }

    const modificationRate = modificationStats.total_with_feedback > 0
      ? Math.round((modificationStats.modified_count / modificationStats.total_with_feedback) * 10000) / 100
      : 0

    return {
      code: 0,
      data: {
        range_days: rangeDays,
        overview: {
          total: overview.total,
          success_count: overview.success_count,
          success_rate: successRate,
          avg_duration_ms: overview.avg_duration_ms || 0,
        },
        by_status: byStatus,
        recent_failures: recentFailures,
        modification: {
          total_with_feedback: modificationStats.total_with_feedback,
          modified_count: modificationStats.modified_count,
          modification_rate: modificationRate,
        },
      },
      message: '',
    }
  })

  // GET /api/admin/ai-parse-logs - AI 解析日志列表（全部详细信息）
  app.get('/api/admin/ai-parse-logs', async (request: FastifyRequest) => {
    const db = getDb()
    const { page, page_size, status, user_id, days } = request.query as {
      page?: string
      page_size?: string
      status?: string
      user_id?: string
      days?: string
    }

    const pageNum = Math.max(Number(page) || 1, 1)
    const size = Math.min(Math.max(Number(page_size) || 20, 1), 100)
    const offset = (pageNum - 1) * size

    // 构建过滤条件
    const conditions: string[] = []
    const params: any[] = []

    if (days) {
      const rangeDays = Math.min(Math.max(Number(days), 1), 365)
      const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')
      conditions.push('l.created_at >= ?')
      params.push(sinceDate)
    }

    if (status && ['success', 'empty', 'error', 'timeout'].includes(status)) {
      conditions.push('l.status = ?')
      params.push(status)
    }

    if (user_id) {
      conditions.push('l.user_id = ?')
      params.push(Number(user_id))
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 总数
    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM ai_parse_logs l ${whereClause}`)
      .get(...params) as { total: number }

    // 分页查询，关联用户名
    const logs = db
      .prepare(
        `SELECT l.*, u.username
         FROM ai_parse_logs l
         LEFT JOIN users u ON l.user_id = u.id
         ${whereClause}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset)

    return {
      code: 0,
      data: {
        items: logs,
        pagination: {
          page: pageNum,
          page_size: size,
          total: countRow.total,
          total_pages: Math.ceil(countRow.total / size),
        },
      },
      message: '',
    }
  })

  // GET /api/admin/ai-parse-logs/:id - 单条解析日志详情
  app.get('/api/admin/ai-parse-logs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const log = db
      .prepare(
        `SELECT l.*, u.username
         FROM ai_parse_logs l
         LEFT JOIN users u ON l.user_id = u.id
         WHERE l.id = ?`,
      )
      .get(Number(id))

    if (!log) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在' }
    }

    return { code: 0, data: log, message: '' }
  })

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

    const pageNum = Math.max(Number(page) || 1, 1)
    const size = Math.min(Math.max(Number(page_size) || 50, 1), 200)
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

  // PUT /api/admin/settings - 修改全局设置
  app.put('/api/admin/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = updateSettingsSchema.parse(request.body)
      const db = getDb()

      const allowedKeys = [
        'ai_base_url',
        'ai_api_key',
        'ai_model',
        'ai_temperature_parse',
        'ai_temperature_chat',
        'currency',
      ]

      const upsert = db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      )

      const updateAll = db.transaction(() => {
        for (const [key, value] of Object.entries(body)) {
          if (!allowedKeys.includes(key)) continue
          upsert.run(key, value)
        }
      })

      updateAll()
      return { code: 0, data: null, message: '设置已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })
}

/**
 * 用户设置路由 - /api/settings
 */
export async function userSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/settings - 获取用户设置（合并全局+用户级）
  app.get('/api/settings', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    // 全局设置
    const globalRows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>
    const settings: Record<string, string> = {}
    for (const row of globalRows) {
      // 普通用户不能看到 API Key
      if (row.key === 'ai_api_key') continue
      settings[row.key] = row.value
    }

    // 用户级设置覆盖
    const userRows = db
      .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
      .all(userId) as Array<{ key: string; value: string }>
    for (const row of userRows) {
      settings[row.key] = row.value
    }

    return { code: 0, data: settings, message: '' }
  })

  // PUT /api/settings - 修改用户级设置
  app.put('/api/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = updateSettingsSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const allowedKeys = ['default_account_id', 'theme', 'ai_model']

      const upsert = db.prepare(
        "INSERT OR REPLACE INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))",
      )

      const updateAll = db.transaction(() => {
        for (const [key, value] of Object.entries(body)) {
          if (!allowedKeys.includes(key)) continue
          upsert.run(userId, key, value)
        }
      })

      updateAll()
      return { code: 0, data: null, message: '设置已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })
}
