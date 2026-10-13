/**
 * 这条测试在锁什么
 * ----------------
 * **噪声闸（L1）的出参可审计性**，三条线：
 *
 * 1. **广告不被记账**：`淘宝闪购10元红包未查收` 这类文案在 `verify.ts` 的分流层
 *    **漏过**（它的 coupon_facevalue 语境词表没有 未查收/未领取），所以它会真的
 *    调到模型、真的回一笔 item。这一笔必须被噪声闸拦成
 *    `category_id=null` + `category_reason='noise_word'` + `noise_term` 非空。
 * 2. **窄语境的决定可复核**（Step 4 产品决策：宽度不改，但要记录）：
 *    窄语境放过、而 verify 宽口径会判的判例，item 上带
 *    `noise_verdict_source='broad'` + `noise_term=null`，由管理员事后看
 *    `ai_parse_logs.parsed_items`。审计靠整份 items JSON，**零 migration**。
 * 3. **不给每笔都塞噪音**：普通账（非噪声判例）这三个字段**一律不存在**。
 *    既有的键一字未改（契约 §6 只允许追加机械字段），客户端可以完全忽略。
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

/** 模型把这条广告归成「红包收入」——正是线上出过的那类事故 */
const REDPACKET_AS_INCOME = JSON.stringify([
  { type: 'income', amount: 10, category: '红包', description: '闪购红包', date: '', account: '', target_account: '' },
])
/** 同一句广告，但模型归到用户自建的「优惠券」分类（噪声闸优先级高于精确命中） */
const COUPON_AS_EXPENSE = JSON.stringify([
  { type: 'expense', amount: 10, category: '优惠券', description: '闪购红包', date: '', account: '', target_account: '' },
])

describe('ai/parse · 噪声闸审计字段', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'noiseaudit')
    // 用户自建一个与内置噪声词同名的分类（「误报面 = 0」要验的就是这种形状）
    const userId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('noiseaudit') as { id: number }
    getDb()
      .prepare("INSERT INTO categories (user_id, name, type, icon) VALUES (?, '优惠券', 'expense', '🎫')")
      .run(userId.id)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as never })

  it('广告文案 + 模型归「红包收入」→ category_id=null / category_reason=noise_word', async () => {
    mockState.reply = REDPACKET_AS_INCOME
    const res = await post({ input: '淘宝闪购10元红包未查收' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.items).toHaveLength(1)
    const item = body.data.items[0]
    // 闸住了：不给任何分类（金额仍是模型给的，不在本次范围内）
    expect(item.category_id).toBeNull()
    expect(item.category_name).toBe('')
    expect(item.category_reason).toBe('noise_word')
    expect(item.noise_term).toBe('红包')
    expect(item.noise_verdict_source).toBe('narrow')
  })

  it('噪声闸优先级高于 L2 精确：模型归到用户自建的「优惠券」也一样被拦', async () => {
    mockState.reply = COUPON_AS_EXPENSE
    const res = await post({ input: '淘宝闪购10元红包未查收' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_id).toBeNull()
    expect(item.category_reason).toBe('noise_word')
    expect(item.noise_verdict_source).toBe('narrow')
  })

  it('真实红包收入 → 正常归类，且这三个字段一个都不出现', async () => {
    mockState.reply = REDPACKET_AS_INCOME
    const res = await post({ input: '你收到一个5.00元红包' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_name).toBe('红包') // 种子收入分类「红包」→ 精确命中
    expect(item.category_reason).toBeUndefined()
    expect(item.noise_term).toBeUndefined()
    expect(item.noise_verdict_source).toBeUndefined()
  })

  it('窄语境放过、宽口径会判的判例 → source=broad / noise_term=null（人工复核对象）', async () => {
    mockState.reply = COUPON_AS_EXPENSE
    // 「优惠券50」：窄语境不含「优惠」→ 放行归类；verify 宽语境含「优惠」→ 会判噪声
    const res = await post({ input: '优惠券50' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_id).not.toBeNull()      // 当场不杀
    expect(item.category_name).toBe('优惠券')
    expect(item.category_reason).toBe('exact')
    expect(item.noise_term).toBeNull()
    expect(item.noise_verdict_source).toBe('broad')
  })

  it('quick 路径同样带证据：判据只用 input，噪声闸也只看 input', async () => {
    mockState.reply = ''
    const res = await post({ input: '午饭32元', title: '淘宝闪购10元红包未查收' })
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_name).toBe('餐饮') // title 里的广告词不参与判据
    expect(item.noise_verdict_source).toBeUndefined()
  })

  it('审计字段落进 ai_parse_logs.parsed_items（不新增表/迁移就能复核）', async () => {
    mockState.reply = REDPACKET_AS_INCOME
    await post({ input: '淘宝闪购10元红包未查收' })
    const row = getParseLogRow()
    const parsed = JSON.parse(row.parsed_items) as Array<Record<string, unknown>>
    expect(parsed[0]!.category_reason).toBe('noise_word')
    expect(parsed[0]!.noise_term).toBe('红包')
    expect(parsed[0]!.noise_verdict_source).toBe('narrow')
  })

  function getParseLogRow(): { parsed_items: string } {
    return getDb()
      .prepare('SELECT parsed_items FROM ai_parse_logs ORDER BY id DESC LIMIT 1')
      .get() as { parsed_items: string }
  }
})