/**
 * 这条测试在锁什么
 * ----------------
 * **不变量：`category_id === null ⇒ needs_review === true`**
 *
 * 为什么是硬不变量：`needs_review` 是客户端「不自动入账」的**唯一**判据。
 * 如果 `category_id: null` 却 `needs_review: false`，客户端会**静默自动入账**一笔
 * 服务端明知「归不出来」的账——前端（Step 6）再怎么如实呈现「未归类」都没用，
 * 因为用户根本看不到那张卡片。
 *
 * 结构上它由 `!categoryExact` 一条保证（lib/parse-extract.ts 的 deriveReviewMeta）：
 * `resolveCategory` 的 `is_exact` 在 L7 留空与 L1 噪声闸两条路径上必然为 false。
 * 本文件从**出参**这一侧把不变量钉住（防止将来有人给留空态开一个
 * 「先自动入账、之后再补分类」的后门）。
 *
 * 两条形状各测一遍：
 *   ① 用户没有「其他」桶 + 模型给了归不出来的科目 → null + category_fuzzy
 *   ② 噪声闸判掉（广告文案 + 模型归到红包收入）→ null + category_fuzzy
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

const UNKNOWN_CATEGORY = JSON.stringify([
  { type: 'expense', amount: 45, category: '不存在的科目XYZ', description: '肯德基', date: '', account: '', target_account: '' },
])
const REDPACKET_AS_INCOME = JSON.stringify([
  { type: 'income', amount: 10, category: '红包', description: '闪购红包', date: '', account: '', target_account: '' },
])

describe('不变量 · category_id=null ⇒ needs_review=true', () => {
  let app: FastifyInstance
  let tokenWithOther: string
  let tokenNoOther: string

  beforeAll(async () => {
    app = await buildApp()
    tokenWithOther = await createUser(app, 'invwith')
    // 另一个用户删掉「其他」桶 → 归不出来只能留空（null）
    tokenNoOther = await createUser(app, 'invnoother')
    const user = getDb().prepare('SELECT id FROM users WHERE username = ?').get('invnoother') as { id: number }
    getDb()
      .prepare("UPDATE categories SET is_active = 0 WHERE user_id = ? AND name = '其他'")
      .run(user.id)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (token: string, input: string) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: { input } })

  it('没有「其他」桶 + 归不出来的科目 → null 且 needs_review=true', async () => {
    mockState.reply = UNKNOWN_CATEGORY
    const res = await post(tokenNoOther, '肯德基消费45.00元')
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_id).toBeNull()
    expect(item.category_name).toBe('')
    expect(item.needs_review).toBe(true)
    expect(item.confidence_reasons).toContain('category_fuzzy')
  })

  it('有「其他」桶 → 落「其他」桶（不是 null），同样 needs_review=true', async () => {
    mockState.reply = UNKNOWN_CATEGORY
    const res = await post(tokenWithOther, '肯德基消费45.00元')
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_name).toBe('其他')
    expect(item.category_id).not.toBeNull()
    expect(item.needs_review).toBe(true)
  })

  it('噪声闸判掉的广告 → category_id=null 仍必须 needs_review=true（不许静默入账）', async () => {
    mockState.reply = REDPACKET_AS_INCOME
    const res = await post(tokenWithOther, '淘宝闪购10元红包未查收')
    const item = JSON.parse(res.payload).data.items[0]
    expect(item.category_id).toBeNull()
    expect(item.category_reason).toBe('noise_word')
    expect(item.needs_review).toBe(true)
  })

  it('穷举这三种形状：没有一条 category_id=null 却 needs_review=false', async () => {
    const cases: Array<[string, string]> = [
      [tokenNoOther, '肯德基消费45.00元'],
      [tokenWithOther, '肯德基消费45.00元'],
      [tokenWithOther, '淘宝闪购10元红包未查收'],
    ]
    for (const [token, input] of cases) {
      const res = await post(token, input)
      const body = JSON.parse(res.payload)
      for (const item of body.data.items as Array<{ category_id: number | null; needs_review: boolean }>) {
        if (item.category_id === null) expect(item.needs_review).toBe(true)
      }
    }
  })
})