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
import { pageParam } from '../lib/pagination.js'
import { loadFilterStats } from '../lib/filter-report.js'
import { filterStats } from '../lib/parse-filter.js'
import { AI_UNAVAILABLE_FAILURE_CODES } from '../lib/ai-failure.js'
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
  'investments',          // → accounts（漏了会 DELETE accounts 抛外键约束 → 有持仓的用户删不掉）
  'transactions',         // → categories / accounts
  'client_capture_samples', // → users（ON DELETE CASCADE）；漏了会因外键删不掉用户
  'ai_conversations',
  'ai_parse_logs',
  'ai_parse_filters',     // 无外键，但同样是 user 维度数据（漏了会留下永久孤儿行）
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
  /* 人工裁决记录（migration 023）：既可能挂在目标用户的解析行上（`parse_log_id → ai_parse_logs`），
     也可能是目标用户作为 admin 留下的（`admin_id → users`）。必须在删 `ai_parse_logs` / `users`
     **之前**清，否则外键约束会让「有裁决记录的用户」删不掉。 */
  db.prepare(
    `DELETE FROM admin_unparsed_triage
      WHERE parse_log_id IN (SELECT id FROM ai_parse_logs WHERE user_id = ?)
         OR admin_id = ?`,
  ).run(userId, userId)

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

/** P2 人工裁决入参（docs/ARCHITECTURE.md §3.9）：`reason` 必填，可追责/可复盘 */
const triageSchema = z.object({
  action: z.enum(['mark_bill', 'mark_not_bill', 'mark_rule_missing']),
  reason: z.string().min(1, 'reason 不能为空').max(500, 'reason 过长'),
})

/** 采样人工标注（契约 docs/API.md 附录 C §11.6：admin 裁决为准，同 admin/unparsed 口径） */
const captureLabelSchema = z.object({
  label: z.enum(['is_bill', 'not_bill']),
})

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

  // GET /api/admin/filter-stats —— 客户端拦截计数 vs 服务端入站拦截原因（契约 §4）
  //
  // ⚠️ 只含**计数**，不含任何用户内容（raw_input 才是敏感的）；跨用户聚合不写审计日志。
  // 不回「误杀率」——那要靠语料 `expect_txn` 才能判，用计数相减算出来的是编的。
  app.get('/api/admin/filter-stats', async (request: FastifyRequest) => {
    const { days } = request.query as { days?: string }
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 365)
    return { code: 0, data: loadFilterStats(getDb(), null, rangeDays), message: '' }
  })

  // GET /api/admin/unparsed —— 「不确定」集中裁决面 · P1 只读（design: docs/ARCHITECTURE.md §3.9）
  //
  // 客户端把「AI 失败 = 不确定」移出用户视野后，这些失败只剩服务端留痕。本端点把它们
  // 集中捞出来，让「这段窗口到底漏了哪些」可查。**只读、不写账、不重跑 AI、不碰判定链**。
  //
  // 默认**不给原文**：只给 `text_preview`（首 60 字）+ `raw_input_len`（够判「像不像账」）；
  // `include_raw=1` 才给全文，并写审计（与 GET /api/admin/ai-parse-logs 同口径）。
  app.get('/api/admin/unparsed', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const rangeDays = Math.min(Math.max(Number(q.days) || 7, 1), 90)
    const page = pageParam(q.page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(q.page_size, 20, 100)
    const includeRaw = q.include_raw === '1'

    if (q.channel !== undefined && !['nls', 'sms', 'a11y', 'manual'].includes(q.channel)) {
      reply.code(400)
      return { code: 2000, data: null, message: `channel 非法：${q.channel}` }
    }
    const channel = q.channel

    // 裁决动作过滤（P2 候选池导出：`?triage=mark_rule_missing` 即「待整理规则候选」）
    const TRIAGE_ACTIONS = ['mark_bill', 'mark_not_bill', 'mark_rule_missing'] as const
    if (q.triage !== undefined && !(TRIAGE_ACTIONS as readonly string[]).includes(q.triage)) {
      reply.code(400)
      return { code: 2000, data: null, message: `triage 非法：${q.triage}` }
    }
    const triageFilter = q.triage

    // failure_code 逗号多值；只接受 unavailable 集合（真源 lib/ai-failure.ts，不手抄）
    let codes: readonly string[] = AI_UNAVAILABLE_FAILURE_CODES
    if (q.failure_code) {
      const asked = q.failure_code.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = asked.find((c) => !AI_UNAVAILABLE_FAILURE_CODES.includes(c as never))
      if (asked.length === 0 || bad) {
        reply.code(400)
        return {
          code: 2000,
          data: null,
          message: `failure_code 非法或不属于 unavailable 集合：${bad ?? '(空)'}`,
        }
      }
      codes = asked
    }

    let targetUserId: number | null = null
    if (q.user_id !== undefined && q.user_id !== '') {
      const uid = Number(q.user_id)
      if (!Number.isInteger(uid) || uid <= 0) {
        reply.code(400)
        return { code: 2000, data: null, message: 'user_id 非法' }
      }
      targetUserId = uid
    }

    const db = getDb()
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const codePlaceholders = codes.map(() => '?').join(', ')
    const conds: string[] = [`failure_code IN (${codePlaceholders})`, 'created_at >= ?']
    const params: unknown[] = [...codes, since]
    if (channel) {
      conds.push('channel = ?')
      params.push(channel)
    }
    if (targetUserId !== null) {
      conds.push('user_id = ?')
      params.push(targetUserId)
    }
    if (triageFilter) {
      /* 「当前态」= 该 log 最新一行的 action（同 log 不同 action 允许、改判留历史）；
         用相关子查询而不是 `IN`，否则「先 mark_rule_missing 后 mark_bill」会被两个桶都算。 */
      conds.push(
        `(SELECT t.action FROM admin_unparsed_triage t WHERE t.parse_log_id = ai_parse_logs.id ORDER BY t.id DESC LIMIT 1) = ?`,
      )
      params.push(triageFilter)
    }
    const where = `WHERE ${conds.join(' AND ')}`

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM ai_parse_logs ${where}`).get(...params) as { c: number }).c

    const rows = db
      .prepare(
        `SELECT id, created_at, channel, source_package, failure_code, attempts, status, raw_input
           FROM ai_parse_logs ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, size, (page - 1) * size) as Array<{
      id: number
      created_at: string
      channel: string | null
      source_package: string | null
      failure_code: string
      attempts: number | null
      status: string
      raw_input: string | null
    }>

    const preview = (s: string | null): string => {
      const t = s ?? ''
      return t.length > 60 ? `${t.slice(0, 60)}…` : t
    }

    /* P2：把每行**最新的**裁决（当前态）带出来，供管理页显示与「候选池」查看。
       同 log 可能有多次/不同 action（历史不删），这里只取 id 最大的一行。 */
    const triageByLog = new Map<number, { action: string; reason: string; admin_id: number; created_at: string }>()
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      const tRows = db
        .prepare(
          `SELECT parse_log_id, action, reason, admin_id, created_at
             FROM admin_unparsed_triage
            WHERE parse_log_id IN (${ids.map(() => '?').join(', ')})
            ORDER BY id DESC`,
        )
        .all(...ids) as Array<{
        parse_log_id: number
        action: string
        reason: string
        admin_id: number
        created_at: string
      }>
      for (const t of tRows) {
        if (!triageByLog.has(t.parse_log_id)) {
          triageByLog.set(t.parse_log_id, {
            action: t.action,
            reason: t.reason,
            admin_id: t.admin_id,
            created_at: t.created_at,
          })
        }
      }
    }

    const items = rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      channel: r.channel,
      source_package: r.source_package,
      failure_code: r.failure_code,
      attempts: r.attempts,
      status: r.status,
      raw_input_len: (r.raw_input ?? '').length,
      text_preview: preview(r.raw_input),
      /* 默认脱敏：只给预览；`include_raw=1` 才给全文（并审计） */
      raw_input: includeRaw ? r.raw_input : null,
      /** 当前态裁决（P2）；null = 尚未裁决 */
      triage: triageByLog.get(r.id) ?? null,
    }))

    /* 跨用户读原文 → 审计（与 recent_failures / 解析日志列表同口径，ARCHITECTURE §5.3）。
       仓库目前**没有「自部署 / SaaS」模式标志**，所以统一按最保守的「默认关原文」实现；
       自部署默认开等策略待有模式标志后再谈（见 docs/ARCHITECTURE.md §3.9）。 */
    if (includeRaw && items.length > 0) {
      appLog('warn', 'admin', `查看未解析原文（${items.length} 条，含跨用户原文）`, {
        action: 'view_unparsed_raw',
        admin_id: request.user!.userId,
        returned: items.length,
        days: rangeDays,
        channel: channel ?? null,
        target_user_id: targetUserId,
      })
    }

    const byFailureCode = db
      .prepare(
        `SELECT failure_code, COUNT(*) AS count FROM ai_parse_logs ${where}
          GROUP BY failure_code ORDER BY count DESC`,
      )
      .all(...params) as Array<{ failure_code: string; count: number }>
    const byChannel = db
      .prepare(
        `SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*) AS count FROM ai_parse_logs ${where}
          GROUP BY COALESCE(channel, 'unknown') ORDER BY count DESC`,
      )
      .all(...params) as Array<{ channel: string; count: number }>

    return {
      code: 0,
      data: {
        window: { days: rangeDays },
        include_raw: includeRaw,
        items,
        pagination: { page, page_size: size, total, total_pages: Math.ceil(total / size) },
        summary: { total, by_failure_code: byFailureCode, by_channel: byChannel },
      },
      message: '',
    }
  })

  // POST /api/admin/unparsed/:id/triage —— P2 人工裁决（design: docs/ARCHITECTURE.md §3.9）
  //
  // ⚠️ 硬边界：**绝不改 `ai_parse_logs`**（机器事实与人工意见分开存）、**绝不写 `transactions`**
  // （不绕过「未确认不得声称已记」）。产品决策（2026-10，选 A）：`mark_bill` 也**不回推客户端**。
  // 幂等：同 (parse_log_id, admin_id, action) 重复提交返回成功（created=false）；同 log 不同 action 允许。
  app.post('/api/admin/unparsed/:id/triage', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: { action: 'mark_bill' | 'mark_not_bill' | 'mark_rule_missing'; reason: string }
    try {
      body = triageSchema.parse(request.body)
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }

    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400)
      return { code: 2000, data: null, message: 'id 非法' }
    }

    const db = getDb()
    const log = db.prepare('SELECT id, failure_code FROM ai_parse_logs WHERE id = ?').get(id) as
      | { id: number; failure_code: string | null }
      | undefined
    /* 只允许裁决「不确定」失败记录（与 P1 列表同一集合）；入参类 / 非失败 / 不存在一律 404。
       不区分「不存在」与「不是该集合」——避免泄漏「这个 id 存在但类型不同」。 */
    if (
      !log ||
      !log.failure_code ||
      !(AI_UNAVAILABLE_FAILURE_CODES as readonly string[]).includes(log.failure_code)
    ) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在或不是「不确定」失败记录' }
    }

    const adminId = request.user!.userId
    const inserted = db
      .prepare(
        `INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parse_log_id, admin_id, action) DO NOTHING`,
      )
      .run(id, body.action, body.reason, adminId)
    const saved = db
      .prepare(
        'SELECT id, created_at FROM admin_unparsed_triage WHERE parse_log_id = ? AND admin_id = ? AND action = ?',
      )
      .get(id, adminId, body.action) as { id: number; created_at: string }

    const created = inserted.changes > 0
    return {
      code: 0,
      data: {
        id: saved.id,
        parse_log_id: id,
        action: body.action,
        created,
        created_at: saved.created_at,
      },
      message: created ? '裁决已记录' : '裁决已存在（幂等）',
    }
  })

  // GET /api/admin/capture-samples —— 客户端拦截内容采集面（契约 §11.4 / §11.6）
  //
  // 客户端在本地丢掉的样本在这里被 review。**只读**：不写账、不重跑 AI、不改判定链。
  // `text` 原文**默认返回**（§11.5 的 P1 决策：先把「被拦了什么」拿到），含跨用户原文，
  // 所以按 ARCHITECTURE §5.3 写一条读审计（同 `GET /api/admin/unparsed?include_raw=1` 口径）。
  app.get('/api/admin/capture-samples', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const rangeDays = Math.min(Math.max(Number(q.days) || 7, 1), 90)
    const pageNum = pageParam(q.page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(q.page_size, 20, 100)

    if (q.channel !== undefined && !['nls', 'sms', 'a11y'].includes(q.channel)) {
      reply.code(400)
      return { code: 2000, data: null, message: `channel 非法：${q.channel}` }
    }

    const db = getDb()
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    const conds: string[] = ['created_at >= ?']
    const params: unknown[] = [since]
    if (q.channel) { conds.push('channel = ?'); params.push(q.channel) }
    if (q.blocked_by) { conds.push('blocked_by = ?'); params.push(q.blocked_by) }
    if (q.package) { conds.push('package = ?'); params.push(q.package) }
    const where = `WHERE ${conds.join(' AND ')}`

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM client_capture_samples ${where}`).get(...params) as { c: number }
    ).c
    const byBlockedBy = db
      .prepare(
        `SELECT blocked_by AS key, COUNT(*) AS count FROM client_capture_samples ${where}
          GROUP BY blocked_by ORDER BY count DESC LIMIT 50`,
      )
      .all(...params) as Array<{ key: string; count: number }>
    const byPackage = db
      .prepare(
        `SELECT package AS key, COUNT(*) AS count FROM client_capture_samples ${where}
          GROUP BY package ORDER BY count DESC LIMIT 50`,
      )
      .all(...params) as Array<{ key: string; count: number }>

    if (total > 0) {
      appLog('warn', 'admin', `查看客户端拦截样本（${total} 条，含原文）`, {
        action: 'view_capture_samples',
        admin_id: request.user!.userId,
        returned: Math.min(size, total),
      })
    }

    const items = db
      .prepare(
        `SELECT * FROM client_capture_samples ${where}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, size, (pageNum - 1) * size)

    return {
      code: 0,
      data: {
        items,
        summary: { total, by_blocked_by: byBlockedBy, by_package: byPackage },
        pagination: { page: pageNum, page_size: size, total, total_pages: Math.ceil(total / size) },
      },
      message: '',
    }
  })

  // POST /api/admin/capture-samples/:id/label —— 人工标注（契约 §11.6）
  //
  // 幂等：同一样本重复标注返回成功（不挡重复提交）。「是账」的后续整理（进
  // `rules.json.testcases(expect_txn=true)`）仍走发布流程，**不允许在线改判据**。
  app.post('/api/admin/capture-samples/:id/label', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: { label: 'is_bill' | 'not_bill' }
    try {
      body = captureLabelSchema.parse(request.body)
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }

    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400)
      return { code: 2000, data: null, message: 'id 非法' }
    }

    const db = getDb()
    const row = db.prepare('SELECT id FROM client_capture_samples WHERE id = ?').get(id)
    if (!row) {
      reply.code(404)
      return { code: 3002, data: null, message: '记录不存在' }
    }

    db.prepare('UPDATE client_capture_samples SET label = ? WHERE id = ?').run(body.label, id)
    return { code: 0, data: null, message: '' }
  })

  // GET /api/admin/ai-parse-stats - AI 解析质量统计
  app.get('/api/admin/ai-parse-stats', async (request: FastifyRequest) => {
    const db = getDb()
    const { days } = request.query as { days?: string }
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 365)
    const sinceDate = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')



    // 总量 + 成功率 + 平均时长
    //
    // ⚠️ 「判非账」与「失败」在这里分开：`status='empty'` 且 `failure_code IS NULL`
    // = AI **明确判非账**（回了 `[]`），**不是故障**；只有 error/timeout 才是「AI 挂了」。
    // 旧口径把 empty 也算进「非成功」，「AI 挂了」的信号被噪声活埋（客户端专项明确要求）。
    //
    // 「不可用」还须排除**入参类失败**（input_empty/input_too_long）：那是客户端 bug，
    // 不是「AI 挂了」（与 lib/ai-failure.ts 的 AI_INPUT_FAILURE_CODES 对应）。
    const UNAVAILABLE = `status IN ('error', 'timeout') AND (failure_code IS NULL OR failure_code NOT IN ('input_empty', 'input_too_long'))`
    const overview = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
          COALESCE(SUM(CASE WHEN ${UNAVAILABLE} THEN 1 ELSE 0 END), 0) as unavailable_count,
          COALESCE(SUM(CASE WHEN status = 'empty' AND failure_code IS NULL THEN 1 ELSE 0 END), 0) as not_a_bill_count,
          COALESCE(SUM(CASE WHEN COALESCE(attempts, 1) > 1 THEN 1 ELSE 0 END), 0) as retried_count,
          COALESCE(SUM(CASE WHEN COALESCE(attempts, 1) > 1 AND status = 'success' THEN 1 ELSE 0 END), 0) as retry_rescued,
          ROUND(AVG(duration_ms)) as avg_duration_ms
         FROM ai_parse_logs
         WHERE created_at >= ?`,
      )
      .get(sinceDate) as {
      total: number
      success_count: number
      unavailable_count: number
      not_a_bill_count: number
      retried_count: number
      retry_rescued: number
      avg_duration_ms: number | null
    }

    const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0)
    const successRate = pct(overview.success_count, overview.total)
    const unavailableRate = pct(overview.unavailable_count, overview.total)
    const notABillRate = pct(overview.not_a_bill_count, overview.total)

    // 失败原因分布（022 的 failure_code）。这是「AI 挂了」的唯一可机械聚合的信号。
    const byFailureCode = db
      .prepare(
        `SELECT failure_code, COUNT(*) as count
           FROM ai_parse_logs
          WHERE created_at >= ? AND failure_code IS NOT NULL
          GROUP BY failure_code
          ORDER BY count DESC`,
      )
      .all(sinceDate) as Array<{ failure_code: string; count: number }>

    // 按渠道拆分（channel 是 019 的可空列；老 APK / 未上报的归 'unknown'）。
    const byChannelRows = db
      .prepare(
        `SELECT COALESCE(channel, 'unknown') as channel,
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
                COALESCE(SUM(CASE WHEN status = 'empty' AND failure_code IS NULL THEN 1 ELSE 0 END), 0) as not_a_bill_count,
                COALESCE(SUM(CASE WHEN ${UNAVAILABLE} THEN 1 ELSE 0 END), 0) as unavailable_count
           FROM ai_parse_logs
          WHERE created_at >= ?
          GROUP BY COALESCE(channel, 'unknown')
          ORDER BY total DESC`,
      )
      .all(sinceDate) as Array<{
      channel: string
      total: number
      success_count: number
      not_a_bill_count: number
      unavailable_count: number
    }>
    const byChannel = byChannelRows.map((c) => ({
      ...c,
      unavailable_rate: pct(c.unavailable_count, c.total),
    }))

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
        `SELECT id, user_id, raw_input, status, error_message, duration_ms, created_at,
                failure_code, attempts, channel
         FROM ai_parse_logs
         WHERE created_at >= ? AND status IN ('error', 'timeout')
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(sinceDate)

    return {
      code: 0,
      data: {
        range_days: rangeDays,
        overview: {
          total: overview.total,
          success_count: overview.success_count,
          success_rate: successRate,
          unavailable_count: overview.unavailable_count,
          unavailable_rate: unavailableRate,
          not_a_bill_count: overview.not_a_bill_count,
          not_a_bill_rate: notABillRate,
          retried_count: overview.retried_count,
          retry_rescued: overview.retry_rescued,
          avg_duration_ms: overview.avg_duration_ms || 0,
        },
        by_status: byStatus,
        /* 失败原因分布（按 failure_code）与按渠道拆分 —— 客户端把失败移出用户视野后，
           这两个是「AI 挂了」的唯一可见信号（见 docs/API.md 附录 C §9 / DATA §13.4）。 */
        by_failure_code: byFailureCode,
        by_channel: byChannel,
        /* recent_failures 里带**跨用户**的 raw_input（用户原话）——与「查看他人明细/原文」同口径，
           属于排障用途，按 ARCHITECTURE §5.3 必须写审计日志（复核：此前这条是审计缺口）。 */
        recent_failures: (() => {
          if (recentFailures.length > 0) {
            appLog('warn', 'admin', `查看解析失败明细（${recentFailures.length} 条，含跨用户原文）`, {
              admin_id: request.user!.userId,
              returned: recentFailures.length,
            })
          }
          return recentFailures
        })(),
        /* 服务端**预筛**统计（入站/出站分流）：`ai_parse_logs` 里看不到「被规则挡下、根本没调模型」
           的那些（它们记在 `ai_parse_filters`）——线上实测 53% 的通知在这里就被丢了，所以
           「空结果率」类指标必须与它一起看。⚠️ 这个函数此前**无任何消费者**（死代码），
           「服务端挡了多少」只能手工 SQL 查。 */
        prefilter: filterStats(db, null, rangeDays),
      },
      message: '',
    }
  })

/**
 * 已下线字段：`user_modified` / `modification_detail` 随 `POST /api/ai/parse-feedback` 一起废弃。
 * 列保留（禁改已应用 migration），但**不再返回**给客户端；`final_items` 保留（落地回填仍在写它）。
 */
function stripRetiredParseLogFields(row: Record<string, unknown>): Record<string, unknown> {
  const { user_modified: _userModified, modification_detail: _modificationDetail, ...rest } = row
  return rest
}

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

    const pageNum = pageParam(page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(page_size, 20, 100)
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

    // 审计：解析日志含用户原始输入（raw_input），跨用户读取按 warn 记一条
    appLog('warn', 'admin', '管理员查看 AI 解析日志列表', {
      action: 'view_ai_parse_logs',
      admin_id: request.user!.userId,
      target_user_id: user_id ? Number(user_id) : null,
    })

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
        items: (logs as Array<Record<string, unknown>>).map(stripRetiredParseLogFields),
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

    // 审计：单条详情直接返回 raw_input 原文，跨用户读取按 warn 记一条
    appLog('warn', 'admin', `管理员查看 AI 解析原文: log_id=${id}`, {
      action: 'view_ai_parse_log_raw',
      admin_id: request.user!.userId,
      log_id: Number(id),
      target_user_id: (log as { user_id?: number }).user_id ?? null,
    })

    return { code: 0, data: stripRetiredParseLogFields(log as Record<string, unknown>), message: '' }
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

    const pageNum = pageParam(page, 1, Number.MAX_SAFE_INTEGER)
    const size = pageParam(page_size, 50, 200)
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
