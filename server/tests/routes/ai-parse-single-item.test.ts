/**
 * 「一次解析只回一笔」—— **取消批量记账** 的契约不变量
 *
 * 产品决定（2026-10）：`POST /api/ai/parse` 的 `items` 恒 ≤ 1，被裁掉的笔数以
 * `extra_items_dropped` 回给客户端（**不静默**）；全部条目仍写进
 * `ai_parse_logs.parsed_items`（服务端保留可诊断现场）。
 *
 * 背景：客户端原先 `maxByOrNull { aiItemScore }` 取一笔、其余**静默丢弃**
 * （不计数、不告知）→ 与「失败绝不静默」冲突。现在单笔语义由契约保证。
 *
 * 锁住：
 *   1. 模型回多笔 → 响应只有 1 笔 + `extra_items_dropped = N-1`；
 *   2. 挑中的是主笔（有货币单位佐证 / 完整度 / 金额降序，见 lib/main-item.ts）；
 *   3. 全部条目仍落日志（可诊断）；
 *   4. 单笔时 `extra_items_dropped = 0`（客户端可无条件计数）；
 *   5. 出站被丢弃的空态也带该字段（形状统一）。
 *
 * 模型调用全部打桩，离线。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

const mockState = vi.hoisted(() => ({ reply: '' }))

vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return { ...orig, chatCompletion: vi.fn(async () => mockState.reply) }
})

/** 三笔都带货币单位（都过佐证）→ 只能靠 ②完整度 ③金额 分胜负 */
const THREE_ITEMS = JSON.stringify([
  { type: 'expense', amount: 8, category: '餐饮', description: '早餐', date: '', account: '微信', target_account: '' },
  { type: 'expense', amount: 25, category: '餐饮', description: '午饭', date: '', account: '微信', target_account: '' },
  { type: 'expense', amount: 4, category: '交通', description: '地铁', date: '', account: '微信', target_account: '' },
])

describe('ai/parse 单笔不变量（取消批量记账）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'singleitem')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as any })

  it('模型回 3 笔 → 只回 1 笔（金额最大者）并报 extra_items_dropped=2', async () => {
    mockState.reply = THREE_ITEMS
    const res = await post({ input: '共3笔：早餐8元，午饭25元，地铁4元' })
    const data = JSON.parse(res.payload).data

    expect(data.source).toBe('ai') // 确认走的是模型路径（不是 quick/预筛）
    expect(data.items).toHaveLength(1)
    expect(data.items[0].amount).toBe(2500) // 25 元 → 分
    expect(data.items[0].description).toContain('午饭')
    expect(data.extra_items_dropped).toBe(2)

    // 全部条目仍落日志（服务端保留完整现场，可诊断）
    const row = getDb()
      .prepare('SELECT parsed_items FROM ai_parse_logs WHERE id = ?')
      .get(data.parse_log_id) as { parsed_items: string }
    expect(JSON.parse(row.parsed_items)).toHaveLength(3)
  })

  it('单笔时 extra_items_dropped = 0（客户端可无条件计数）', async () => {
    mockState.reply = JSON.stringify([
      { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '', account: '', target_account: '' },
    ])
    const res = await post({ input: '午饭消费32.00元' })
    const data = JSON.parse(res.payload).data
    expect(data.items).toHaveLength(1)
    expect(data.extra_items_dropped).toBe(0)
  })

  it('出站全丢弃的空态也带该字段（形状统一，客户端不用分支）', async () => {
    // 模型回一笔，但原文里没有带货币单位的佐证 → 出站 verify 丢弃
    mockState.reply = JSON.stringify([
      { type: 'expense', amount: 99, category: '其他', description: '凭空', date: '', account: '', target_account: '' },
    ])
    const res = await post({ input: '今天天气不错' })
    const data = JSON.parse(res.payload).data
    expect(data.items).toHaveLength(0)
    expect(data.extra_items_dropped).toBe(0)
  })
})
