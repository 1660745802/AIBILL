/**
 * ④ 的真实交付路径（契约 §3）：从**仓库真源文件**发布 → 客户端 GET 能拿到 `precheck`。
 *
 * 为什么单独一个文件：本文件会 `publishRulesFromFile` 往 DB 写新激活版本（这正是要验的行为），
 * 会污染同库里其它用例的预设激活行——所以必须独占一个 DB（= 一个测试文件）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { publishRulesFromFile } from '../../src/lib/notification-rules.js'

const RULES_PATH = fileURLToPath(new URL('../../config/rules.json', import.meta.url))
const REAL_RULES = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'))

describe('precheck 下发端到端（文件 → DB → GET）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await loginAdmin(app)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const getRules = () =>
    app.inject({ method: 'GET', url: '/api/config/notification-rules' })

  it('发布真源文件后，GET 下发 precheck（id/tier/desc/signals 齐备）且剔除 testcases', async () => {
    const res = publishRulesFromFile(getDb(), RULES_PATH)
    expect(res.published).toBe(true)

    const body = JSON.parse((await getRules()).payload)
    const pre = body.data.rules.precheck
    expect(pre.schema).toBe(1)
    expect(pre.derived_from).toBe('src/ai/verify.ts')
    expect(pre.channel_agnostic).toBe(true)
    expect(pre.rules.length).toBeGreaterThan(5)
    expect(pre.rules.some((r: { id: string }) => r.id === 'precheck.money+verb')).toBe(true)
    expect(pre.rules.every((r: { desc?: string }) => (r.desc ?? '').length > 0)).toBe(true)
    expect(pre.signals.money.pattern.length).toBeGreaterThan(0)
    expect(pre.signals.money.flags).toBe('gi')
    // 语料不进下发 payload
    expect(body.data.rules.testcases).toBeUndefined()
    // ETag 绑的就是这一次发布的 payload hash
    expect(body.data.content_hash).toBe(res.content_hash)
  })

  it('ETag 命中 → 304（下发链路没被 precheck 改动破坏）', async () => {
    const first = await getRules()
    const etag = first.headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    const second = await app.inject({
      method: 'GET',
      url: '/api/config/notification-rules',
      headers: { 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
  })

  it('admin POST 也注入 precheck（否则激活它会弄丢整个判据），并拒绝手写 precheck', async () => {
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/notification-rules',
        headers: authHeaders(token),
        payload: payload as never,
      })

    const okRules = {
      ...REAL_RULES,
      // 与刚才从文件发布的载荷区分开，否则会撞 content_hash 唯一性（那是正确行为）
      processor: { ...REAL_RULES.processor, dedup_window_seconds: 61 },
    }
    delete (okRules as Record<string, unknown>).testcases
    const res = await post({ rules: okRules })
    expect(res.statusCode).toBe(200)
    const stored = JSON.parse(JSON.parse(res.payload).data.rules)
    expect(stored.precheck?.schema).toBe(1)
    expect(stored.testcases).toBeUndefined()

    // 手写 precheck：由代码派生，不静默剥离而是直接 400
    const bad = await post({ rules: { ...okRules, precheck: { schema: 1, rules: [] } } })
    expect(bad.statusCode).toBe(400)
    expect(JSON.parse(bad.payload).message).toMatch(/precheck 由代码派生/)
  })
})
