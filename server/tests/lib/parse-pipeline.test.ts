/**
 * 解析编排（`lib/parse-pipeline.ts`）——`POST /api/ai/parse` 的唯一业务入口
 *
 * 这个 module 的价值在于：**路由不再需要知道重试预算 / 预筛 / 装配 / 回填**，
 * 编排的 interface 就是 `runParse(db, args) → ParseOutcome`。所以这里**直接打
 * runParse**（不走 Fastify inject / 不发 HTTP），锁住判别联合的几种形态与
 * 它们的出参数据，让「编排本身」能在不启动 web 层的情况下被断言。
 *
 * 覆盖：quick 成功 / 入站预筛(not_a_bill) / 空结果(5001·not_a_bill) /
 *       AI 不可用(unavailable) / 输入超限(400·unavailable)。
 * 模型调用离线打桩（`vi.mock` ai/client），不发真实请求。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { initDb, closeDb, getDb } from '../../src/db/index.js'
import { ensureAdminUser } from '../../src/services/auth.service.js'
import { runParse, type ParseInput } from '../../src/lib/parse-pipeline.js'

const stub = vi.hoisted(() => ({ reply: '[]', error: null as null | { type: string; message: string } }))
vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => {
      if (stub.error) throw new orig.AiError(stub.error.type, stub.error.message)
      return stub.reply
    }),
  }
})

/** 以「原始 body 与已校验 body 相同」的方式直调 runParse（本文件不用 a11y 截断）。 */
const call = (input: string, extra: Partial<ParseInput> = {}) => {
  const body: ParseInput = { input, ...extra }
  return runParse(getDb(), { userId: 1, body, rawBody: body })
}

describe('parse-pipeline · runParse 的 interface', () => {
  beforeAll(() => {
    process.env.DB_PATH = ':memory:'
    try { closeDb() } catch { /* 首次 */ }
    initDb()
    // 管理员（id=1）连带生成默认分类（含「餐饮」）与默认账户（微信/支付宝/…）
    ensureAdminUser()
  })
  afterAll(() => closeDb())
  beforeEach(() => {
    stub.reply = '[]'
    stub.error = null
  })

  it('quick 成功 → kind=parsed / source=quick，并落一条 status=success 的日志', async () => {
    const out = await call('午饭32')
    expect(out.kind).toBe('parsed')
    if (out.kind !== 'parsed') throw new Error('兜底：上面已断言 kind')
    expect(out.source).toBe('quick')
    expect(out.items).toHaveLength(1)
    expect(out.droppedCount).toBe(0)
    expect(out.hintsConflict).toBe(false)
    expect(out.rawInput).toBe('午饭32')
    expect(typeof out.logId).toBe('number')

    const row = getDb()
      .prepare('SELECT status, ai_response, attempts FROM ai_parse_logs WHERE id = ?')
      .get(out.logId) as { status: string; ai_response: string; attempts: number }
    expect(row).toMatchObject({ status: 'success', ai_response: '[quick-parse]', attempts: 0 })
  })

  it('入站预筛挡下 → kind=filtered / source=prefilter / outcome=not_a_bill（不调模型）', async () => {
    const out = await call('双11 5折 全场开抢')
    expect(out).toEqual({
      kind: 'filtered',
      source: 'prefilter',
      rawInput: '双11 5折 全场开抢',
      outcome: 'not_a_bill',
      message: '',
    })
  })

  it('模型判非账（回 []）→ kind=empty（5001 / not_a_bill）且带 parse_log_id', async () => {
    stub.reply = '[]'
    const out = await call('某笔消费12.5元，用于兼容性检查')
    expect(out.kind).toBe('empty')
    if (out.kind !== 'empty') throw new Error('兜底：上面已断言 kind')
    expect(out).toMatchObject({
      httpStatus: 200,
      outcome: 'not_a_bill',
      message: 'AI 无法解析，请尝试手动记账',
      rawInput: '某笔消费12.5元，用于兼容性检查',
    })
    expect(typeof out.logId).toBe('number')
  })

  it('AI 超时 → kind=ai_error（504 / unavailable），raw_input 保留原文', async () => {
    stub.error = { type: 'AI_TIMEOUT', message: '上游超时' }
    const out = await call('肯德基消费45.00元')
    expect(out).toEqual({
      kind: 'ai_error',
      message: '上游超时',
      httpStatus: 504,
      outcome: 'unavailable',
      rawInput: '肯德基消费45.00元',
    })
  })

  it('输入超渠道上限 → kind=input_too_long（400 / unavailable），attempts=0', async () => {
    const out = await call('x'.repeat(3001))
    expect(out).toEqual({
      kind: 'input_too_long',
      httpStatus: 400,
      outcome: 'unavailable',
      message: '输入过长',
    })
  })
})
