/**
 * `POST /api/ai/parse` 出参扩展（契约 docs/API.md 附录 C §6）
 *
 * 锁住：
 *   1. quick(#2) 与 ai(#4) 两条成功路径的 items 都挂齐机械字段；
 *   2. `confidence` / `confidence_reasons` / `needs_review` 按 §6 唯一阈值派生
 *      （分类未精确命中 / bare_amount / verify review）；
 *   3. #4 补 `source:'ai'`；
 *   4. `balance_text` 与 `balance_after_cents` 必在同一元素；
 *   5. **判据只用 `input`**：`title`/`body` 只参与抽取、不参与 tier/佐证；
 *   6. 既有键（type/amount/category_id/description/date…）语义一字不变。
 *
 * 所有模型调用打桩，离线。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

/** 每个用例先设好模型要返回的 JSON */
const mockState = vi.hoisted(() => ({ reply: '' }))

vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => mockState.reply),
  }
})

/** 一笔「餐饮/肯德基/45 元」的模型输出（金额相关用例复用） */
const KFC_45 = JSON.stringify([
  { type: 'expense', amount: 45, category: '餐饮', description: '肯德基', date: '', account: '', target_account: '' },
])

describe('ai/parse 出参扩展（§6）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'parseout')
    // 云控 source_mapping（测试环境默认不 seed，这里给一条用于验证 merchant）
    getDb()
      .prepare('INSERT INTO notification_rules (version, rules, is_active) VALUES (?, ?, 1)')
      .run(1, JSON.stringify({ source_mapping: { 'com.sankuai.meituan': '美团' } }))
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as any })

  it('quick(#2)：字段挂齐、既有键不变、confidence=high/needs_review=false', async () => {
    const res = await post({ input: '午饭32元' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.source).toBe('quick')

    const item = body.data.items[0]
    // 既有键语义不变
    expect(item.type).toBe('expense')
    expect(item.amount).toBe(3200)
    expect(item.description).toBe('午饭')
    expect(item.category_name).toBe('餐饮')
    expect(typeof item.category_id).toBe('number')
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(item.account_id).toBeNull()
    expect(item.target_account_id).toBeNull()

    // 新增机械字段
    expect(item).toMatchObject({
      merchant: null,
      order_no: null,
      card_tail: null,
      balance_after_cents: null,
      balance_text: null,
      time: null,
      confidence: 'high',
      needs_review: false,
    })
    expect(item.confidence_reasons).toEqual(['quick', 'category_exact', 'amount_unit'])
    expect(item).not.toHaveProperty('source') // source 是响应级，不是 item 级

    // 落库（parsed_items 是 JSON TEXT，零 migration）
    const row = getDb()
      .prepare('SELECT parsed_items FROM ai_parse_logs WHERE id = ?')
      .get(body.data.parse_log_id) as { parsed_items: string }
    expect(JSON.parse(row.parsed_items)[0].confidence).toBe('high')
  })

  it('quick(#2)：抽取 balance/card_tail/time/merchant，balance_text 与余额同元素', async () => {
    const res = await post({
      input: '午饭32元 尾号1234 14:32 余额100.50元',
      source: { package_name: 'com.sankuai.meituan' },
    })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.merchant).toBe('美团')
    expect(item.card_tail).toBe('1234')
    expect(item.balance_after_cents).toBe(10050)
    expect(item.balance_text).toBe('余额100.50元')
    expect(item.time).toBe('14:32')
  })

  it('quick(#2)：无单位金额 → confidence=low，但 needs_review=false', async () => {
    const res = await post({ input: '午饭32' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.confidence).toBe('low')
    expect(item.needs_review).toBe(false)
    expect(item.confidence_reasons).toContain('amount_bare')
  })

  it('ai(#4)：补 source=ai、medium/needs_review=false', async () => {
    mockState.reply = KFC_45
    const res = await post({ input: '肯德基消费45.00元' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.source).toBe('ai')

    const item = body.data.items[0]
    expect(item.type).toBe('expense')
    expect(item.amount).toBe(4500)
    expect(item.description).toBe('肯德基')
    expect(item.category_name).toBe('餐饮')
    expect(item.confidence).toBe('medium')
    expect(item.needs_review).toBe(false)
    expect(item.confidence_reasons).toEqual(['ai', 'category_exact', 'amount_unit'])
  })

  it('ai(#4)：金额来自裸数字 → needs_review=true / low', async () => {
    mockState.reply = KFC_45
    const res = await post({ input: '肯德基45' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.needs_review).toBe(true)
    expect(item.confidence).toBe('low')
    expect(item.confidence_reasons).toContain('amount_bare')
    expect(item.confidence_reasons).toContain('verify_review')
  })

  it('ai(#4)：分类未精确命中（回落「其他」）→ needs_review=true / category_fuzzy', async () => {
    mockState.reply = JSON.stringify([
      { type: 'expense', amount: 45, category: '不存在的科目', description: '肯德基', date: '', account: '', target_account: '' },
    ])
    const res = await post({ input: '肯德基消费45.00元' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_name).toBe('其他')
    expect(item.needs_review).toBe(true)
    expect(item.confidence).toBe('low')
    expect(item.confidence_reasons).toContain('category_fuzzy')
  })

  it('ai(#4)：判据只用 input——body 里有带单位金额也不进金额佐证', async () => {
    mockState.reply = KFC_45
    // input 是裸数字（tier2/bare_amount、无佐证）；body 里有「45.00元」
    const res = await post({ input: '肯德基45', title: '', body: '肯德基消费45.00元' })
    const item = JSON.parse(res.payload).data.items[0]
    // 若误把 body 并入佐证，则 verify 会 pass、needs_review 会变 false
    expect(item.needs_review).toBe(true)
    expect(item.confidence_reasons).toContain('verify_review')
  })

  it('ai(#4)：input 抽不到时可退回 title/body 抽取（仅抽取，不影响判据）', async () => {
    mockState.reply = KFC_45
    const res = await post({ input: '肯德基消费45.00元', title: '【美团】' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.merchant).toBe('美团')
    expect(item.needs_review).toBe(false)
  })
})
