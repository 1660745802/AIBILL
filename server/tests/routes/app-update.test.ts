/**
 * App 自托管更新（APK 分发）路由测试
 *
 * 重点两件：
 *   1. `version_name` 是完全可控的表单字段，而它**派生磁盘文件名** ——
 *      `../../dist/app.js` 这种值会把文件写到存储目录之外（容器里是 root，
 *      可以覆盖自己的代码/数据库）。下载侧 app.ts 早有穿越防护，写入侧此前没有。
 *   2. 公开接口 `GET /api/app/update` 只暴露版本信息，不泄露敏感字段。
 *
 * ⚠️ 这里自己建 app（而不是用 tests/helpers 的 buildApp）：app.ts 会注册
 * @fastify/multipart，而 helpers 只 registerRoutes —— 上传接口需要它。
 * UPDATES_DIR 由 tests/setup.ts 指到系统临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { initDb, closeDb, getDb } from '../../src/db/index.js'
import { registerRoutes } from '../../src/routes/index.js'
import { ensureAdminUser } from '../../src/services/auth.service.js'
import { loginAdmin, authHeaders } from '../helpers.js'
import { config } from '../../src/config.js'
import fs from 'node:fs'
import path from 'node:path'

const BOUNDARY = '----aibilltestboundary'

/** 最小合法 APK 内容：ZIP 文件头 `PK\x03\x04` + 任意 payload（内容校验只认文件头） */
const APK_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('FAKE-APK-BYTES')])

/** 手搓 multipart body（不引入 form-data 依赖） */
function multipartBody(fields: Record<string, string>, fileField?: { name: string; filename: string; content: Buffer }): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (fileField) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n`
      + 'Content-Type: application/vnd.android.package-archive\r\n\r\n',
    ))
    parts.push(fileField.content)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(parts)
}

describe('App Update Routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    process.env.DB_PATH = ':memory:'
    try { closeDb() } catch { /* 首次 */ }
    initDb()
    ensureAdminUser()
    app = Fastify({ logger: false })
    await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })
    await registerRoutes(app)
    await app.ready()
    token = await loginAdmin(app)
  })

  afterAll(async () => {
    await app.close()
    closeDb()
  })

  const upload = (fields: Record<string, string>, versionName: string) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/updates',
      headers: {
        ...authHeaders(token),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        { version_name: versionName, version_code: fields.version_code ?? '10000' },
        { name: 'apk_file', filename: 'app-release.apk', content: APK_BYTES },
      ),
    })

  it('version_name 带路径穿越必须被拒，且不写任何文件到目录外', async () => {
    // `path.join(dir, 'aibill-' + v + '.apk')` 里 '..' 要成为真正的父目录引用，
    // 前面必须先有**一个真正的目录段**（`x/..`），所以有效载荷形如 'x/../../evil'：
    // node -e 实测 'x/../../evil' → <UPDATES_DIR>/../evil.apk（真的跳出去了）
    const outsideTarget = path.resolve(config.updatesDir, '..', 'evil.apk')
    const outsideRoot = path.resolve(config.updatesDir, '..', '..', 'evil.apk')
    fs.rmSync(outsideTarget, { force: true })
    fs.rmSync(outsideRoot, { force: true })

    for (const bad of ['x/../../evil', 'x/../../../evil', '..', 'a/b', 'a\\b']) {
      const res = await upload({}, bad)
      expect(res.statusCode, bad).toBe(400)
      expect(JSON.parse(res.payload).code, bad).toBe(2000)
    }
    expect(fs.existsSync(outsideTarget)).toBe(false)
    expect(fs.existsSync(outsideRoot)).toBe(false)
  })

  it('合法 version_name 正常上传并激活，文件落在 UPDATES_DIR 内', async () => {
    const res = await upload({ version_code: '10100' }, '1.4.0')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.apk_url).toBe('/updates/aibill-1.4.0.apk')
    expect(fs.existsSync(path.join(config.updatesDir, 'aibill-1.4.0.apk'))).toBe(true)
  })

  it('公开接口只回版本信息（无认证、无敏感字段）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/app/update?versionCode=10000' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.has_update).toBe(true)
    // versionCode 是**数字比较**（10100 > 10000）；字符串比较会得出 "10100" < "9999"
    expect(body.data.latest_version_code).toBe(10100)
    expect(Object.keys(body.data).sort()).toEqual([
      'apk_size', 'apk_url', 'changelog', 'force_update', 'has_update',
      'latest_version', 'latest_version_code',
    ])
    // 无激活版本 / 版本不旧 → has_update=false
    const same = JSON.parse((await app.inject({ method: 'GET', url: '/api/app/update?versionCode=10100' })).payload)
    expect(same.data.has_update).toBe(false)
  })

  it('非 APK 内容（缺 ZIP 文件头）必须被拒，不落盘也不进库', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/updates',
      headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(
        { version_name: '9.9.9', version_code: '99999' },
        { name: 'apk_file', filename: 'not-apk.apk', content: Buffer.from('<html>not an apk</html>') },
      ),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2000)
    expect(fs.existsSync(path.join(config.updatesDir, 'aibill-9.9.9.apk'))).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) c FROM app_updates WHERE version_name = ?').get('9.9.9')).toEqual({ c: 0 })
  })

  it('未认证不得上传（/api/admin/updates 必须 admin）', async () => {    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/updates',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody({ version_name: '9.9.9', version_code: '99999' }, { name: 'apk_file', filename: 'x.apk', content: APK_BYTES }),
    })
    expect(res.statusCode).toBe(401)
    expect(getDb().prepare('SELECT COUNT(*) c FROM app_updates WHERE version_name = ?').get('9.9.9')).toEqual({ c: 0 })
  })

  it('历史版本列表的分页参数非法值不得 500', async () => {
    // 回归：`?page=abc` → parseInt 得 NaN → LIMIT/OFFSET 绑 NaN → SqliteError → 500
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/updates?page=abc&page_size=1e999',
      headers: authHeaders(token),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.page).toBe(1)
    expect(body.data.page_size).toBe(20)
    // 合法值仍然生效
    const ok = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/updates?page=1&page_size=5', headers: authHeaders(token) })).payload,
    )
    expect(ok.data.page_size).toBe(5)
    expect(ok.data.total).toBeGreaterThan(0)
  })
})
