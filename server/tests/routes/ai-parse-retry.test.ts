/**
 * 服务端侧**有限重试**（重试责任划分：服务端做，见 docs/API.md 附录 C §3）
 *
 * 客户端不再对 5xx/超时重试，且失败后不打扰用户 → 「瞬时故障救回来」只能由服务端做。
 * 本用例锁住：
 *   1. 可重试类型（超时 / 网络 / 5xx / 格式错 / 非空但全不合法）→ 再问一次，`attempts=2`；
 *   2. 不可重试类型（401 / KeyMissing / 4xx）→ **只调一次**，不浪费额度；
 *   3. 「AI 判非账」（回 `[]`）不是失败 → **不重试**，`failure_code` 为 NULL、`outcome='not_a_bill'`；
 *   4. 重试仍失败 → 落库 `failure_code` 区分原因，响应带 `outcome='unavailable'`。
 *
 * 全部离线：`chatCompletion` 打桩，按调用序回放脚本。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

interface MockStep {
  reply?: string
  error?: { type: string; message: string; status?: number; retryAfterMs?: number }
}

const mock = vi.hoisted(() => ({ calls: 0, steps: [] as MockStep[] }))

vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => {
      const step = mock.steps[Math.min(mock.calls, mock.steps.length - 1)]
      mock.calls++
      if (step?.error) {
        throw new orig.AiError(step.error.type, step.error.message, {
          status: step.error.status,
          retryAfterMs: step.error.retryAfterMs,
        })
      }
      return step?.reply ?? '[]'
    }),
  }
})

/** 一笔过机械校验的消费（带单位佐证，确保走到模型路径而不是别处） */
const KFC = JSON.stringify([
  { type: 'expense', amount: 45, category: '餐饮', description: '肯德基', date: '', account: '', target_account: '' },
])

/** 「非空、但一条都不合法」：amount=0 会被 validateParsedItems 丢掉 */
const ALL_INVALID = JSON.stringify([
  { type: 'expense', amount: 0, category: '餐饮', description: '坏条目', date: '', account: '', target_account: '' },
])

describe('ai/parse 服务端重试（lib/ai-failure 策略）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'retrycase')
  })
  afterAll(async () => {
    await teardownApp(app)
  })
  beforeEach(() => {
    mock.calls = 0
    mock.steps = []
  })

  const post = () => app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: { input: '肯德基消费45.00元' } as never })

  /** 最近一条日志行 */
  const lastLog = () =>
    getDb()
      .prepare('SELECT status, failure_code, attempts FROM ai_parse_logs ORDER BY id DESC LIMIT 1')
      .get() as { status: string; failure_code: string | null; attempts: number | null }

  it('超时后重试一次成功 → code 0 / attempts=2 / failure_code 为 NULL', async () => {
    mock.steps = [{ error: { type: 'AI_TIMEOUT', message: '超时' } }, { reply: KFC }]
    const body = JSON.parse((await post()).payload)
    expect(body.code).toBe(0)
    expect(body.data.source).toBe('ai')
    expect(body.data.items).toHaveLength(1)
    expect(mock.calls).toBe(2)
    const row = lastLog()
    expect(row).toMatchObject({ status: 'success', failure_code: null, attempts: 2 })
  })

  it('401（配置问题）不重试 → 只调一次 / failure_code=AI_KEY_INVALID / outcome=unavailable', async () => {
    mock.steps = [{ error: { type: 'AI_KEY_INVALID', message: 'Key 无效', status: 401 } }]
    const res = await post()
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(5001)
    expect(body.outcome).toBe('unavailable')
    expect(mock.calls).toBe(1)
    expect(lastLog()).toMatchObject({ status: 'error', failure_code: 'AI_KEY_INVALID', attempts: 1 })
  })

  it('上游 5xx 重试；4xx 不重试', async () => {
    mock.steps = [
      { error: { type: 'AI_API_ERROR', message: 'AI 接口错误 (503)', status: 503 } },
      { reply: KFC },
    ]
    expect(JSON.parse((await post()).payload).code).toBe(0)
    expect(mock.calls).toBe(2)

    mock.calls = 0
    mock.steps = [{ error: { type: 'AI_API_ERROR', message: 'AI 接口错误 (400)', status: 400 } }]
    const res = await post()
    expect(mock.calls).toBe(1)
    expect(lastLog().failure_code).toBe('AI_API_ERROR')
    expect(res.statusCode).toBe(502)
  })

  it('模型不是 JSON → 重试一次成功（parse_format）', async () => {
    mock.steps = [{ reply: '这不是 JSON' }, { reply: KFC }]
    const body = JSON.parse((await post()).payload)
    expect(body.code).toBe(0)
    expect(mock.calls).toBe(2)
    expect(lastLog()).toMatchObject({ status: 'success', failure_code: null, attempts: 2 })
  })

  it('非空但全不合法（parse_invalid）→ 重试后仍失败 → 5002 + failure_code=parse_invalid', async () => {
    mock.steps = [{ reply: ALL_INVALID }]
    const res = await post()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(5002)
    expect(body.outcome).toBe('unavailable')
    expect(mock.calls).toBe(2)
    expect(lastLog()).toMatchObject({ status: 'error', failure_code: 'parse_invalid', attempts: 2 })
  })

  it('AI 判非账（回 []）不是失败 → 不重试 / outcome=not_a_bill / failure_code 为 NULL', async () => {
    mock.steps = [{ reply: '[]' }]
    const body = JSON.parse((await post()).payload)
    expect(body.code).toBe(5001)
    expect(body.outcome).toBe('not_a_bill')
    expect(body.parse_log_id).toBeTypeOf('number')
    expect(mock.calls).toBe(1) // 判非账不重试
    expect(lastLog()).toMatchObject({ status: 'empty', failure_code: null, attempts: 1 })
  })
})
