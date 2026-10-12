/**
 * 分流记录的 `duration_ms` 语义（DATA §10.4 / `ai_parse_filters`）
 *
 * 回归：出站那条曾经用 `Date.now() - startTime` 记时，把**整段模型调用**
 * （parse 的超时上限是 60s）算进了「判定耗时」，而文档要求这个字段是
 * 「判定本身花掉的毫秒数（分流是纯字符串匹配，应 <1ms）」。
 * 后果：`filterStats` 的 `medianMs` / `maxMs` 不再是「预筛比模型快两个数量级」
 * 的证据，而是一个没有意义的数。
 *
 * 这里的模型被桩成固定慢 80ms，所以「不含模型调用」是可判定的：
 * 任何把模型耗时算进去的计时都不可能小于 30ms。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

/** 模型调用固定慢这么多毫秒 */
const MODEL_DELAY_MS = 80
/** 判定耗时（纯正则）的宽松上界 */
const JUDGE_MS_CEILING = 30

vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, MODEL_DELAY_MS))
      // 原文写着「共2笔 220.00元」→ 这个「110 + 110」是模型平摊出来的，
      // 出站判定 isFabricatedSplit → drop，于是会写一条 outbound 分流记录。
      const one = {
        type: 'expense', amount: 110, category: '其他',
        description: '昨天支出', date: '2026-10-12', account: '', target_account: '',
      }
      return JSON.stringify([one, one])
    }),
  }
})

interface FilterRow {
  stage: string
  tier: number
  reasons: string
  duration_ms: number
}

describe('ai_parse_filters · duration_ms 只记判定耗时', () => {
  let app: FastifyInstance
  let token: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'filterdur')
    userId = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).payload,
    ).data.user.id
    getDb().exec('DELETE FROM ai_parse_filters')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const filterRows = (): FilterRow[] =>
    getDb()
      .prepare('SELECT stage, tier, reasons, duration_ms FROM ai_parse_filters WHERE user_id = ? ORDER BY id')
      .all(userId) as FilterRow[]
  it('出站 drop：duration_ms 不含整段模型调用', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/parse',
      headers: authHeaders(token),
      payload: { input: '昨天共有2笔支出 220.00元，共2笔' },
    })
    const body = JSON.parse(res.payload)
    expect(res.statusCode).toBe(200)
    expect(body.data.source).toBe('postfilter')   // fabricated_split → 出站丢弃
    expect(body.data.items).toEqual([])

    const outbound = filterRows().filter((r) => r.stage === 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.reasons).toContain('fabricated_split')
    // 模型是 80ms；判定（正则）必须远小于它
    expect(outbound[0]!.duration_ms).toBeLessThan(JUDGE_MS_CEILING)
  })

  it('入站拦截：duration_ms 同样不含 quickParse 与分类查询', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/parse',
      headers: authHeaders(token),
      payload: { input: '😍1号会员日来啦 🛒12包抽纸0元领千份放量！ 🔥实付159元再享40元红包返利>' },
    })
    expect(JSON.parse(res.payload).data.source).toBe('prefilter')

    const inbound = filterRows().filter((r) => r.stage === 'inbound')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.tier).toBe(0)
    expect(inbound[0]!.duration_ms).toBeLessThan(JUDGE_MS_CEILING)
  })

  it('用户该类型下无活跃分类时：category_id 给 null（不是不存在的 0）', async () => {
    getDb()
      .prepare("UPDATE categories SET is_active = 0 WHERE user_id = ? AND type = 'expense'")
      .run(userId)

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/parse',
      headers: authHeaders(token),
      payload: { input: '肯德基45' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.items.length).toBeGreaterThan(0)
    for (const item of body.data.items) {
      // 0 是「不存在的 id」：客户端拿它去 POST /transactions 会被归属校验 400；
      // null 才是契约内合法值（转账路径本来就是 null）
      expect(item.category_id).toBeNull()
      expect(item.category_name).toBe('')
    }
  })
})
