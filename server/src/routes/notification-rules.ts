/**
 * 通知记账规则云控路由
 * GET  /api/config/notification-rules — 客户端拉取（无认证，ETag/304）
 * POST /api/admin/notification-rules  — 创建新版本（admin）
 * GET  /api/admin/notification-rules  — 查看历史版本（admin）
 * PUT  /api/admin/notification-rules/:id/activate — 激活指定版本（admin）
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

// 内存缓存
let cachedRules: { version: number; rules: any; updated_at: string } | null = null

/**
 * 加载当前激活的规则到内存
 */
function loadActiveRules(): void {
  const db = getDb()
  const row = db
    .prepare('SELECT version, rules, created_at FROM notification_rules WHERE is_active = 1 ORDER BY id DESC LIMIT 1')
    .get() as { version: number; rules: string; created_at: string } | undefined

  if (row) {
    try {
      cachedRules = {
        version: row.version,
        rules: JSON.parse(row.rules),
        updated_at: row.created_at,
      }
    } catch {
      cachedRules = null
    }
  }
}

/**
 * 客户端读取接口（无认证）
 */
export async function configRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/config/notification-rules — 无认证，支持 ETag/304
  app.get('/api/config/notification-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    // 首次加载或缓存为空时从 DB 加载
    if (!cachedRules) {
      loadActiveRules()
    }

    // 无激活规则
    if (!cachedRules) {
      return { code: 0, data: null, message: 'no active rules' }
    }

    // ETag/304：客户端传 If-None-Match 对比版本号
    const clientETag = request.headers['if-none-match']
    const serverETag = `"${cachedRules.version}"`

    if (clientETag === serverETag) {
      reply.code(304)
      return
    }

    // 返回完整规则 + ETag
    reply.header('ETag', serverETag)
    reply.header('Cache-Control', 'no-cache') // 允许缓存但必须验证

    return {
      code: 0,
      data: {
        version: cachedRules.version,
        updated_at: cachedRules.updated_at,
        rules: cachedRules.rules,
      },
      message: '',
    }
  })
}

/**
 * 管理接口（需 admin 认证）
 */
export async function notificationRulesAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)
  app.addHook('preHandler', adminMiddleware)

  const createRulesSchema = z.object({
    version: z.number().int().positive(),
    rules: z.object({
      nls: z.any().optional(),
      a11y: z.any().optional(),
      sms: z.any().optional(),
      source_mapping: z.any().optional(),
      processor: z.any().optional(),
    }),
  })

  // POST /api/admin/notification-rules — 创建新版本
  app.post('/api/admin/notification-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createRulesSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 检查版本号不能重复
      const existing = db
        .prepare('SELECT id FROM notification_rules WHERE version = ?')
        .get(body.version)
      if (existing) {
        reply.code(400)
        return { code: 3001, data: null, message: `版本 ${body.version} 已存在` }
      }

      const result = db
        .prepare('INSERT INTO notification_rules (version, rules, created_by, is_active) VALUES (?, ?, ?, 0)')
        .run(body.version, JSON.stringify(body.rules), userId)

      const row = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(result.lastInsertRowid)
      return { code: 0, data: row, message: '规则版本已创建' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // GET /api/admin/notification-rules — 查看所有版本
  app.get('/api/admin/notification-rules', async () => {
    const db = getDb()
    const rows = db
      .prepare('SELECT id, version, is_active, created_by, created_at FROM notification_rules ORDER BY version DESC')
      .all()
    return { code: 0, data: { items: rows }, message: '' }
  })

  // PUT /api/admin/notification-rules/:id/activate — 激活指定版本
  app.put('/api/admin/notification-rules/:id/activate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const target = db.prepare('SELECT id, version FROM notification_rules WHERE id = ?').get(Number(id)) as any
    if (!target) {
      reply.code(404)
      return { code: 3002, data: null, message: '规则版本不存在' }
    }

    // 事务：先全部 deactivate，再激活目标
    db.transaction(() => {
      db.prepare('UPDATE notification_rules SET is_active = 0 WHERE is_active = 1').run()
      db.prepare('UPDATE notification_rules SET is_active = 1 WHERE id = ?').run(Number(id))
    })()

    // 刷新内存缓存
    loadActiveRules()

    return { code: 0, data: null, message: `版本 ${target.version} 已激活` }
  })
}
