/**
 * 管理员路由 - /api/admin
 * 邀请码管理、用户管理、全局设置
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import crypto from 'node:crypto'

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
        .prepare('UPDATE users SET is_active = ? WHERE id = ?')
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
