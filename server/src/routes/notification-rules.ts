/**
 * 通知记账规则云控路由
 * GET  /api/config/notification-rules — 客户端拉取（无认证，ETag/304）
 * POST /api/admin/notification-rules  — 创建新版本（admin）
 * GET  /api/admin/notification-rules  — 查看历史版本（admin）
 * PUT  /api/admin/notification-rules/:id/activate — 激活指定版本（admin）
 *
 * 真源在 `server/config/rules.json`（见 lib/notification-rules.ts）。本路由只负责
 * 「下发 / 管理历史版本」：下发时剔除 `testcases`，ETag 绑 `content_hash`。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  buildPublishPayload,
  payloadHash,
  validateRules,
  selfTestTestcases,
  stripTestcases,
  type RulesFile,
} from '../lib/notification-rules.js'

// 内存缓存。
//
// ⚠️ 多实例部署的已知限制：每个实例各持一份缓存，`activate` 只刷新**当前实例**，
// 其他实例要等自身下次 `loadActiveRules`（缓存为空时）/ 重启才会看到新版本。
// 现在没有跨实例失效总线——单实例部署下无影响；上多实例前需要补一条失效通道。
let cachedRules: {
  version: number
  content_hash: string
  rules: RulesFile
  updated_at: string
} | null = null

/**
 * 加载当前激活的规则到内存。
 *
 * 解析失败**不再静默变 null**：记录 error 并抛出，拒绝把坏数据下发给客户端
 * （以前会返回 `no active rules`，让客户端以为没有云控规则，掩盖了库里的损坏）。
 */
function loadActiveRules(): void {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT version, rules, content_hash, created_at FROM notification_rules WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
    )
    .get() as
    | { version: number; rules: string; content_hash: string | null; created_at: string }
    | undefined

  if (!row) {
    cachedRules = null
    return
  }

  let parsed: RulesFile
  try {
    parsed = JSON.parse(row.rules) as RulesFile
  } catch (err) {
    cachedRules = null
    console.error('[notification-rules] 激活规则 JSON 解析失败，拒绝下发坏数据：', err)
    throw new Error('激活规则解析失败')
  }

  const payload = stripTestcases(parsed)
  cachedRules = {
    version: row.version,
    // 老库激活行可能没有 content_hash（migration020 之前）：现算一个，保证 ETag 可用
    content_hash: row.content_hash ?? payloadHash(payload),
    rules: payload,
    updated_at: row.created_at,
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

    // ETag/304：绑内容 hash（不再绑手填的 version）。客户端 ETag 保持 opaque。
    const clientETag = request.headers['if-none-match']
    const serverETag = `"${cachedRules.content_hash}"`

    if (clientETag === serverETag) {
      reply.code(304)
      return
    }

    reply.header('ETag', serverETag)
    reply.header('Cache-Control', 'no-cache') // 允许缓存但必须验证

    return {
      code: 0,
      data: {
        version: cachedRules.version,
        content_hash: cachedRules.content_hash,
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
    // version 可省略：省略则由服务端取 MAX(version)+1
    version: z.number().int().positive().optional(),
    rules: z.unknown(),
  })

  // POST /api/admin/notification-rules — 创建新版本
  app.post('/api/admin/notification-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: { version?: number; rules?: unknown }
    try {
      body = createRulesSchema.parse(request.body)
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }

    // 严格校验：未知键 400、不静默剥离；结构/正则不合规也 400
    const errors = validateRules(body.rules)
    if (errors.length > 0) {
      reply.code(400)
      return { code: 2000, data: null, message: `规则校验失败：${errors.join('；')}` }
    }
    const rules = body.rules as RulesFile

    // 带 testcases 时同样自检（别把坏语料发布进历史版本）
    try {
      selfTestTestcases(rules)
    } catch (err) {
      reply.code(400)
      return { code: 2000, data: null, message: (err as Error).message }
    }

    const db = getDb()
    const userId = request.user!.userId
    /* 两条发布路径（启动读文件 / admin POST）必须产出**同一形状的载荷**：
       `precheck` 由代码派生，两条路都要注入。曾经这里直接用 contentHash(rules)
       并存入裸 rules —— 那样 admin 建/激活的版本会让客户端**丢掉整个判据**。 */
    const payload = buildPublishPayload(rules)
    const hash = payloadHash(payload)

    // content_hash UNIQUE：同一份内容不重复入库
    const dupHash = db
      .prepare('SELECT version FROM notification_rules WHERE content_hash = ? LIMIT 1')
      .get(hash) as { version: number } | undefined
    if (dupHash) {
      reply.code(400)
      return { code: 3001, data: null, message: `相同内容已存在（版本 ${dupHash.version}）` }
    }

    let version = body.version
    if (version === undefined) {
      const maxRow = db.prepare('SELECT MAX(version) AS m FROM notification_rules').get() as {
        m: number | null
      }
      version = (maxRow.m ?? 0) + 1
    } else {
      const existing = db.prepare('SELECT id FROM notification_rules WHERE version = ?').get(version)
      if (existing) {
        reply.code(400)
        return { code: 3001, data: null, message: `版本 ${version} 已存在` }
      }
    }

    const result = db
      .prepare(
        'INSERT INTO notification_rules (version, rules, content_hash, created_by, is_active) VALUES (?, ?, ?, ?, 0)',
      )
      .run(version, JSON.stringify(payload), hash, userId)

    const row = db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(result.lastInsertRowid)
    return { code: 0, data: row, message: '规则版本已创建' }
  })

  // GET /api/admin/notification-rules — 查看所有版本
  app.get('/api/admin/notification-rules', async () => {
    const db = getDb()
    const rows = db
      .prepare(
        'SELECT id, version, content_hash, rules, is_active, created_by, created_at FROM notification_rules ORDER BY version DESC',
      )
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

    // 刷新本实例缓存（多实例限制见文件顶部注释）
    loadActiveRules()

    return { code: 0, data: null, message: `版本 ${target.version} 已激活` }
  })
}
