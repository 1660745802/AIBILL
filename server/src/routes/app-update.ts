/**
 * App 自托管更新路由
 *
 * GET  /api/app/update          — 客户端检查更新（无认证，ETag/304）
 * POST /api/admin/updates       — 上传新版本 APK（admin，multipart）
 * GET  /api/admin/updates       — 查看历史版本（admin，分页）
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// 常量 & 工具
// ---------------------------------------------------------------------------

/** APK 存储目录（相对于 server 工作目录），可通过环境变量覆盖 */
const UPDATES_DIR = config.updatesDir

/** 确保存储目录存在 */
function ensureUpdatesDir(): void {
  if (!fs.existsSync(UPDATES_DIR)) {
    fs.mkdirSync(UPDATES_DIR, { recursive: true })
  }
}

/** 从请求中拼接绝对 URL */
function buildAbsoluteUrl(request: FastifyRequest, filename: string): string {
  // 优先读取 X-Forwarded-Proto / X-Forwarded-Host（反代场景）
  const proto = (request.headers['x-forwarded-proto'] as string) || 'http'
  const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || 'localhost:3000'
  return `${proto}://${host}/updates/${filename}`
}

// ---------------------------------------------------------------------------
// 内存缓存：当前激活版本（类比 notification-rules 的 cachedRules）
// ---------------------------------------------------------------------------

interface CachedUpdate {
  id: number
  version_name: string
  version_code: number
  changelog: string | null
  force_update: boolean
  apk_url: string
  apk_size: number
  created_at: string
}

let cachedUpdate: CachedUpdate | null = null

function loadActiveUpdate(): void {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, version_name, version_code, changelog, force_update, apk_url, apk_size, created_at
       FROM app_updates
       WHERE is_active = 1
       ORDER BY version_code DESC
       LIMIT 1`,
    )
    .get() as CachedUpdate | undefined

  cachedUpdate = row ?? null
}

// ---------------------------------------------------------------------------
// 公开接口：GET /api/app/update
// ---------------------------------------------------------------------------

export async function appUpdatePublicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/app/update', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      versionName?: string
      versionCode?: string
      platform?: string
    }

    const clientVersionCode = parseInt(query.versionCode || '0', 10)

    // 首次 / 缓存为空时从 DB 加载
    if (!cachedUpdate) {
      loadActiveUpdate()
    }

    // ---- 语义 1：billserver 无激活版本 → has_update=false，客户端走 fallback GitHub ----
    if (!cachedUpdate) {
      return {
        code: 0,
        data: {
          has_update: false,
          latest_version: null,
          latest_version_code: null,
          force_update: false,
          changelog: null,
          apk_url: null,
          apk_size: null,
        },
        message: 'no active update',
      }
    }

    // ETag / 304：客户端传 If-None-Match 对比 version_code
    const serverETag = `"${cachedUpdate.version_code}"`
    const clientETag = request.headers['if-none-match']
    if (clientETag === serverETag) {
      reply.code(304)
      return
    }

    // ---- 语义 2：billserver 版本 <= 客户端版本 → has_update=false（不 fallback GitHub）----
    const hasUpdate = cachedUpdate.version_code > clientVersionCode

    // 始终输出绝对 URL（向後兼容：旧记录可能存的是相对路径）
    const absoluteApkUrl = normalizeApkUrl(request, cachedUpdate.apk_url, `aibill-${cachedUpdate.version_name}.apk`)

    reply.header('ETag', serverETag)
    reply.header('Cache-Control', 'no-cache')

    return {
      code: 0,
      data: {
        has_update: hasUpdate,
        latest_version: cachedUpdate.version_name,
        latest_version_code: cachedUpdate.version_code,
        force_update: !!cachedUpdate.force_update,
        changelog: cachedUpdate.changelog,
        apk_url: absoluteApkUrl,
        apk_size: cachedUpdate.apk_size,
      },
      message: '',
    }
  })
}

/**
 * 将存储的 apk_url 规范化为绝对 URL
 * - 已是绝对 URL（http:// 或 https://）→ 原样返回
 * - 是相对路径（/updates/... 或 /downloads/...）→ 重写为绝对 URL（基于请求 host）
 * - 空/其他 → 基于 apk_filename 重新生成
 */
function normalizeApkUrl(request: FastifyRequest, storedUrl: string, filename: string): string {
  const proto = (request.headers['x-forwarded-proto'] as string) || 'http'
  const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || 'localhost:3000'
  if (!storedUrl) {
    return `${proto}://${host}/updates/${filename}`
  }
  if (/^https?:\/\//i.test(storedUrl)) {
    return storedUrl
  }
  // 相对路径（/updates/...、/downloads/...） → 统一重写为 /updates/
  return `${proto}://${host}/updates/${filename}`
}

// ---------------------------------------------------------------------------
// Admin 接口
// ---------------------------------------------------------------------------

export async function appUpdateAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)
  app.addHook('preHandler', adminMiddleware)

  // ---- POST /api/admin/updates — 上传新版本（multipart） ----
  app.post('/api/admin/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    ensureUpdatesDir()

    // 解析 multipart（使用 @fastify/multipart）
    const parts = request.parts()
    const fields: Record<string, string> = {}
    let apkBuffer: Buffer | null = null
    let apkOriginalName = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        // apk_file 字段
        if (part.fieldname === 'apk_file') {
          apkOriginalName = part.filename || 'unknown.apk'
          const chunks: Buffer[] = []
          for await (const chunk of part.file) {
            chunks.push(chunk)
          }
          apkBuffer = Buffer.concat(chunks)
        } else {
          // 跳过非 apk_file 文件字段
          part.file.resume()
        }
      } else {
        // 普通字段
        fields[part.fieldname] = part.value as string
      }
    }

    if (!apkBuffer) {
      reply.code(400)
      return { code: 2000, data: null, message: '缺少 apk_file 字段' }
    }

    // 校验字段
    const versionName = fields.version_name
    const versionCode = parseInt(fields.version_code || '0', 10)
    const changelog = fields.changelog || null
    const forceUpdate = fields.force_update === 'true' || fields.force_update === '1' ? 1 : 0

    if (!versionName) {
      reply.code(400)
      return { code: 2000, data: null, message: '缺少 version_name 字段' }
    }
    if (!versionCode || versionCode <= 0) {
      reply.code(400)
      return { code: 2000, data: null, message: 'version_code 必须为正整数' }
    }

    const db = getDb()

    // 检查 version_code > 当前激活版本（防止回退）
    const activeRow = db
      .prepare('SELECT version_code FROM app_updates WHERE is_active = 1 ORDER BY version_code DESC LIMIT 1')
      .get() as { version_code: number } | undefined

    if (activeRow && versionCode <= activeRow.version_code) {
      reply.code(400)
      return {
        code: 3001,
        data: null,
        message: `version_code (${versionCode}) 必须大于当前激活版本 (${activeRow.version_code})`,
      }
    }

    // 生成文件名 & 写入磁盘
    const safeName = `aibill-${versionName}.apk`
    const filePath = path.join(UPDATES_DIR, safeName)
    fs.writeFileSync(filePath, apkBuffer)
    const apkSize = apkBuffer.length

    // 生成绝对 URL
    const apkUrl = buildAbsoluteUrl(request, safeName)

    // 事务：如果有同 version_code 的旧记录先 deactivate，再插入新记录并激活
    const result = db.transaction(() => {
      // 先把所有 active 置 0
      db.prepare('UPDATE app_updates SET is_active = 0 WHERE is_active = 1').run()
      // 如果同 version_code 已存在（理论上不会，因为 UNIQUE + 校验），也置 0
      db.prepare('UPDATE app_updates SET is_active = 0 WHERE version_code = ?').run(versionCode)

      const insert = db.prepare(
        `INSERT INTO app_updates (version_name, version_code, changelog, force_update, apk_url, apk_size, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      const info = insert.run(versionName, versionCode, changelog, forceUpdate, apkUrl, apkSize)
      return info.lastInsertRowid
    })()

    // 刷新缓存
    loadActiveUpdate()

    const row = db.prepare('SELECT * FROM app_updates WHERE id = ?').get(result) as any
    return {
      code: 0,
      data: {
        id: row.id,
        version_name: row.version_name,
        version_code: row.version_code,
        apk_url: apkUrl,
        apk_size: apkSize,
        changelog: row.changelog,
        force_update: !!row.force_update,
        is_active: !!row.is_active,
        created_at: row.created_at,
      },
      message: '版本已上传并激活',
    }
  })

  // ---- GET /api/admin/updates — 历史版本列表（分页，每页 20 条） ----
  app.get('/api/admin/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; page_size?: string }
    const db = getDb()

    const page = Math.max(1, parseInt(query.page || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size || '20', 10)))
    const offset = (page - 1) * pageSize

    const countRow = db.prepare('SELECT COUNT(*) as total FROM app_updates').get() as { total: number }
    const items = db
      .prepare(
        `SELECT id, version_name, version_code, changelog, force_update, apk_url, apk_size, is_active, created_at
         FROM app_updates
         ORDER BY version_code DESC
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as any[]

    return {
      code: 0,
      data: {
        items: items.map((r) => ({
          id: r.id,
          version_name: r.version_name,
          version_code: r.version_code,
          changelog: r.changelog,
          force_update: !!r.force_update,
          apk_url: r.apk_url,
          apk_size: r.apk_size,
          is_active: !!r.is_active,
          created_at: r.created_at,
        })),
        total: countRow.total,
        page,
        page_size: pageSize,
      },
      message: '',
    }
  })
}