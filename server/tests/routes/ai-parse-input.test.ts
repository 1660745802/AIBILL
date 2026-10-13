/**
 * 入参黑洞收口 + `outcome` 一致性（契约 docs/API.md 附录 C §1/#8、§5）
 *
 * 背景：`input` 空 / 超长此前**直接 400 且不落任何 `ai_parse_logs` 行**
 * —— 客户端只看到失败，服务端什么也看不到，于是「今天漏没漏账」两端都查不到。
 * 本用例锁住三件事：
 *
 *   1. 输入类失败**留痕**（`failure_code=input_empty/input_too_long`，`attempts=0`）；
 *   2. **a11y 长文本放宽 + 超长头部截断**（不再 400 把真账关在门外）；
 *   3. `outcome` 不变量：**空 `items` ⇔ 顶层有 `outcome`**
 *      （#1/#3/#5 = `not_a_bill`；#6/#7/#8 = `unavailable`），且失败响应体是可解析 JSON 信封。
 *
 * 全部离线：`chatCompletion` 打桩。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

const mock = vi.hoisted(() => ({ calls: 0, reply: '[]', error: null as null | { type: string; message: string; status?: number } }))

vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => {
      mock.calls++
      if (mock.error) throw new orig.AiError(mock.error.type, mock.error.message, { status: mock.error.status })
      return mock.reply
    }),
  }
})

/** 造「总额被平摊」的噪声：verify 出站判 fabricated_split */
const SPLIT_REPLY = JSON.stringify([
  { type: 'expense', amount: 50, category: '餐饮', description: 'a', date: '', account: '', target_account: '' },
  { type: 'expense', amount: 50, category: '餐饮', description: 'b', date: '', account: '', target_account: '' },
])

describe('ai/parse 入参收口与 outcome 一致性', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'inputcase')
  })
  afterAll(async () => {
    await teardownApp(app)
  })
  beforeEach(() => {
    mock.calls = 0
    mock.reply = '[]'
    mock.error = null
  })

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as never })

  const lastLog = () =>
    getDb()
      .prepare('SELECT status, failure_code, attempts, raw_input FROM ai_parse_logs ORDER BY id DESC LIMIT 1')
      .get() as { status: string; failure_code: string | null; attempts: number | null; raw_input: string }

  it('#8 空 input → 400 留痕（input_empty / attempts=0）+ outcome=unavailable', async () => {
    const res = await post({ input: '' })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(2000)
    expect(body.outcome).toBe('unavailable') // 顶层、可解析
    expect(mock.calls).toBe(0) // 空输入不调模型
    expect(lastLog()).toMatchObject({ status: 'error', failure_code: 'input_empty', attempts: 0 })
  })

  it('#8 非 a11y 超 3000 → 400 留痕（input_too_long）', async () => {
    const res = await post({ input: 'x'.repeat(3001) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).outcome).toBe('unavailable')
    const row = lastLog()
    expect(row.failure_code).toBe('input_too_long')
    expect(row.raw_input.length).toBeLessThanOrEqual(200) // 超长文本只存前 200 字（隐私/体积）
  })

  it('a11y 3000–8000 长文本被放宽（不 400），照常解析', async () => {
    const res = await post({ input: '消费 100.00 元 ' + 'y'.repeat(5000), channel: 'a11y' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(5001) // 打桩回 [] → 判非账
    expect(body.outcome).toBe('not_a_bill')
    expect(mock.calls).toBe(1)
    expect(lastLog()).toMatchObject({ status: 'empty', failure_code: null, attempts: 1 })
  })

  it('a11y 超 8000 → 截断头部后解析（不 400、不置 failure_code）', async () => {
    const big = '消费 100.00 元 ' + 'z'.repeat(9000)
    const res = await post({ input: big, channel: 'a11y' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).outcome).toBe('not_a_bill')
    expect(mock.calls).toBe(1)
    const row = lastLog()
    expect(row.failure_code).toBeNull()
    expect(row.raw_input.length).toBeLessThanOrEqual(8000) // 截断后入库
  })

  it('#1 入站预筛 → outcome=not_a_bill（空 items ⇔ 有 outcome）', async () => {
    const res = await post({ input: '双11 5折 全场开抢' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.source).toBe('prefilter')
    expect(body.data.items).toHaveLength(0)
    expect(body.outcome).toBe('not_a_bill')
    expect(mock.calls).toBe(0)
  })

  it('#3 出站判噪 → outcome=not_a_bill', async () => {
    mock.reply = SPLIT_REPLY
    const res = await post({ input: '共2笔消费，每笔50.00元，共100.00元' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.source).toBe('postfilter')
    expect(body.data.items).toHaveLength(0)
    expect(body.outcome).toBe('not_a_bill')
  })

  it('#6 超时 → 504 且响应体是可解析 JSON 信封、outcome 在顶层', async () => {
    mock.error = { type: 'AI_TIMEOUT', message: '上游超时' }
    const res = await post({ input: '肯德基消费45.00元' })
    expect(res.statusCode).toBe(504)
    const body = JSON.parse(res.payload) // 必须可解析
    expect(body).toMatchObject({ code: 5001, data: null, fallback: 'manual', outcome: 'unavailable' })
    expect(typeof body.message).toBe('string')
  })

  it('#6 上游 502 → 同上是 JSON 信封 + outcome=unavailable', async () => {
    mock.error = { type: 'AI_API_ERROR', message: 'AI 接口错误 (500)', status: 500 }
    const res = await post({ input: '肯德基消费45.00元' })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.payload)
    expect(body.outcome).toBe('unavailable')
    expect(body.data).toBeNull()
  })
})
