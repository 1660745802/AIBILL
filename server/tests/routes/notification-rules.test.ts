/**
 * 通知规则下发路由回归（发布/真源见 docs/ARCHITECTURE.md §3.7；语料形状见同文件 `validateRules`）。
 *
 * 锁住：ETag 绑 content_hash（不是手填 version）、304、响应剔除 testcases、
 * activate 刷新缓存、admin POST 严格校验 + 服务端算 hash + version 可省略。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

const REAL_RULES = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../../config/rules.json', import.meta.url)), 'utf8'),
)

describe('通知规则云控（content_hash / ETag / 严格校验）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await loginAdmin(app)
    // 测试环境不 seed；手工放一条带 testcases 的激活版本
    getDb()
      .prepare('INSERT INTO notification_rules (version, rules, content_hash, is_active) VALUES (1, ?, ?, 1)')
      .run(
        JSON.stringify({
          source_mapping: { 'com.tencent.mm': '微信支付' },
          testcases: [{ id: 'fixture', text: '双11 5折', expect_tier: 0 }],
        }),
        'hash-v1',
      )
  })

  afterAll(async () => { await teardownApp(app) })

  const getRules = (headers?: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/config/notification-rules', headers })

  const postAdmin = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/admin/notification-rules', headers: authHeaders(token), payload: payload as any })

  it('GET：ETag = "<content_hash>"，响应含 content_hash 且剔除 testcases', async () => {
    const res = await getRules()
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('"hash-v1"')
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.content_hash).toBe('hash-v1')
    expect(body.data.rules.source_mapping['com.tencent.mm']).toBe('微信支付')
    expect(body.data.rules.testcases).toBeUndefined()
  })

  it('If-None-Match 命中 content_hash → 304', async () => {
    const res = await getRules({ 'if-none-match': '"hash-v1"' })
    expect(res.statusCode).toBe(304)
  })

  it('activate 后刷新缓存并切换到新 content_hash', async () => {
    const db = getDb()
    db.prepare('INSERT INTO notification_rules (version, rules, content_hash, is_active) VALUES (2, ?, ?, 0)').run(
      JSON.stringify({ source_mapping: { 'com.tencent.mm': '微信' }, testcases: [] }),
      'hash-v2',
    )
    const id = (db.prepare('SELECT id FROM notification_rules WHERE version = 2').get() as { id: number }).id
    const act = await app.inject({
      method: 'PUT',
      url: `/api/admin/notification-rules/${id}/activate`,
      headers: authHeaders(token),
    })
    expect(act.statusCode).toBe(200)

    const res = await getRules()
    expect(res.headers.etag).toBe('"hash-v2"')
    const body = JSON.parse(res.payload)
    expect(body.data.content_hash).toBe('hash-v2')
  })

  it('admin POST：未知顶层键 → 400（不静默剥离）', async () => {
    const res = await postAdmin({ rules: { ...REAL_RULES, unknown_top: 1 } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).message).toMatch(/未知顶层键/)
  })

  it('admin POST：缺 nls/processor 的裸规则 → 400', async () => {
    const res = await postAdmin({ rules: { source_mapping: { a: 'b' } } })
    expect(res.statusCode).toBe(400)
  })

  it('admin POST：version 省略 → 自动 MAX(version)+1，服务端算 content_hash', async () => {
    const res = await postAdmin({ rules: REAL_RULES })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.version).toBe(3) // 已有 v1 / v2
    expect(body.data.content_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.data.is_active).toBe(0)
  })

  it('admin POST：同内容重复 → 400（content_hash 唯一）', async () => {
    const res = await postAdmin({ rules: REAL_RULES })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).message).toMatch(/相同内容/)
  })

  it('激活损坏的规则行 → fail-loud（500），不再静默变 null', async () => {
    const db = getDb()
    db.prepare('INSERT INTO notification_rules (version, rules, content_hash, is_active) VALUES (99, ?, ?, 0)').run(
      '{ not json',
      'hash-bad',
    )
    const id = (db.prepare('SELECT id FROM notification_rules WHERE version = 99').get() as { id: number }).id
    const res = await app.inject({
      method: 'PUT',
      url: `/api/admin/notification-rules/${id}/activate`,
      headers: authHeaders(token),
    })
    expect(res.statusCode).toBe(500)
  })
})
