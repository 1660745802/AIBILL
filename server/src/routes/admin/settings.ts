/**
 * 全局设置（`/api/admin/settings` 的读 + 写）。
 *
 * 注：拆分后 `PUT /api/admin/settings` 的**注册时机**排在 `GET /api/admin/logs` 之前
 * （拆分前在其后）。路径互不重叠、且全部在 hook 之后注册，行为无差异。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { getDb } from '../../db/index.js'

const updateSettingsSchema = z.record(z.string(), z.string())

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {

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

      if (body.ai_api_key) {
        const current = db.prepare('SELECT value FROM settings WHERE key = ?')
          .get('ai_api_key') as { value: string } | undefined
        // 只拒绝当前 GET 实际返回的 mask；合法密钥中出现 *** 不应被吞掉。
        if (current?.value && body.ai_api_key === current.value.slice(0, 8) + '***') {
          reply.code(400)
          return { code: 2000, data: null, message: '请填写完整 API Key，不能保存脱敏提示值' }
        }
      }

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
 *
 * 唯一**不需要 admin** 的一组：只有 `authMiddleware`。
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
