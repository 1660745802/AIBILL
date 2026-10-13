/**
 * 这条测试在锁什么
 * ----------------
 * 「一次解析只回一笔」这条**契约不变量**在真实 HTTP 路径上仍然成立，且
 * `extra_items_dropped` 数得对。
 *
 * 为什么单独锁：Step 2 删掉 `categories[0]` 兜底之后，「归不出来」的 item 的
 * `category_id` 从「某个真实但错误的分类」变成 `null`，而 `lib/main-item.ts` 的
 * 第二条打分标准是**信息完整度**（分类占 1 分）——也就是说，**归类侧的改动会
 * 改变选笔结果**。选错笔 = 用户确认的是另一笔 = 记错账，且服务端不报错、不告警。
 *
 * 这里的用例刻意让**多笔候选里有一笔归不出来**（模型编了一个不存在的科目），
 * 断言：只回一笔、返回的是哪一笔、被裁掉几笔。评分规则本身不在本次改动范围。
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

/** 模型回两笔：一笔能归类，一笔编了个不存在的科目 */
const TWO_ITEMS = JSON.stringify([
  { type: 'expense', amount: 99, category: '不存在的科目X', description: '说不清的那笔', date: '', account: '', target_account: '' },
  { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '', account: '', target_account: '' },
])

describe('ai/parse · 一次只回一笔（选笔与归类的组合）', () => {
  let app: FastifyInstance
  let token: string
  let tokenNoOther: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'pickseeded')
    // 另一个用户删掉了「其他」桶 → 归不出来只能留空（Step 2 之后的稀疏路径）
    tokenNoOther = await createUser(app, 'picknoother')
    const user = getDb().prepare('SELECT id FROM users WHERE username = ?').get('picknoother') as { id: number }
    getDb()
      .prepare("UPDATE categories SET is_active = 0 WHERE user_id = ? AND name = '其他'")
      .run(user.id)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (token: string, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as never })

  it('两笔候选 → 只回一笔，且 extra_items_dropped=1', async () => {
    mockState.reply = TWO_ITEMS
    const res = await post(token, { input: '零散记了两笔 99.00元 和 32.00元' })
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(0)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.extra_items_dropped).toBe(1)
  })

  it('有「其他」桶时：归不出来那笔仍有分类 id（其他）→ 按完整度与金额选出预期那笔', async () => {
    mockState.reply = TWO_ITEMS
    const res = await post(token, { input: '零散记了两笔 99.00元 和 32.00元' })
    const item = JSON.parse(res.payload).data.items[0]
    // 两笔都拿到分类（第二笔落「其他」桶）→ 完整度相同 → 金额降序 → 99 那笔
    expect(item.amount).toBe(9900)
    expect(item.category_name).toBe('其他')
  })

  it('删掉「其他」桶后：归不出来那笔 category_id=null，完整度少 1 分 → 换成另一笔', async () => {
    mockState.reply = TWO_ITEMS
    const res = await post(tokenNoOther, { input: '零散记了两笔 99.00元 和 32.00元' })
    const body = JSON.parse(res.payload)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.extra_items_dropped).toBe(1)
    const item = body.data.items[0]
    // 选中的是「午饭」那一笔（32 元、能归到餐饮），而不是金额更大的那笔
    expect(item.amount).toBe(3200)
    expect(item.category_name).toBe('餐饮')
    expect(item.needs_review).toBe(false)
  })

  it('被裁掉的那笔仍留在 ai_parse_logs.parsed_items（服务端保留完整现场，不静默丢）', async () => {
    mockState.reply = TWO_ITEMS
    await post(token, { input: '零散记了两笔 99.00元 和 32.00元' })
    const row = getDb()
      .prepare('SELECT parsed_items FROM ai_parse_logs ORDER BY id DESC LIMIT 1')
      .get() as { parsed_items: string }
    const parsed = JSON.parse(row.parsed_items) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.description).toBe('说不清的那笔')
  })
})