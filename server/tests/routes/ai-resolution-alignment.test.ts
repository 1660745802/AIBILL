/**
 * 这条测试在锁什么
 * ----------------
 * **归类结果与 item 不会错位**（出参的 `needs_review` 与 `noise_term` 都挂在**自己那一笔**上）。
 *
 * 背景：`POST /api/ai/parse` 的出参里，`needs_review`（客户端「不自动入账」的唯一护栏）
 * 与 Step 4 追加的 `noise_term` / `noise_verdict_source` 都是**逐笔**从归类结果派生的。
 * 旧实现把归类结果放进一个与 item 平行的 `resolutions[]` 数组，出参阶段按下标回读——
 * 对齐靠的是「每轮恰好 push 一次」这个隐式约定：将来任何人在那段 map 里加一条
 * early return 或第二条条件路径，就会**静默错位**（把 needs_review=false 挂到其实
 * 归不出来的那一笔上 = 客户端自动入账一笔编造的账；反过来把 true 挂到可信的那笔上
 * = 用户莫名被要求确认），而且当时没有任何测试会红。
 *
 * 现在 resolution 与 item 在**同一个结构里**产出，对齐是结构保证。本文件从出参 + 
 * `ai_parse_logs.parsed_items` 两侧验证：构造 transfer 与非 transfer 混合、且其中
 * 一笔会被噪声闸拦下的多笔输入，逐笔断言三个字段挂对地方。
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

/**
 * 三笔、故意交错：
 *   ① 会被噪声闸拦下（requested='红包' + 原文含「红包未查收」语境）
 *   ② transfer（不参与归类 → 没有 resolution，categoryExact 恒 true）
 *   ③ 能精确命中「餐饮」
 * 顺序刻意把「有 resolution 的」「没有 resolution 的」夹在中间 —— 错位最容易在这里发生。
 */
const MIXED_ITEMS = JSON.stringify([
  { type: 'expense', amount: 10, category: '红包', description: '被噪声闸拦下', date: '', account: '', target_account: '' },
  { type: 'transfer', amount: 100, category: '', description: '微信转支付宝', date: '', account: '微信', target_account: '支付宝' },
  { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '', account: '微信', target_account: '' },
])

interface StoredItem {
  type: string
  amount: number
  category_id: number | null
  category_name: string
  description: string
  needs_review: boolean
  category_reason?: string
  noise_term?: string | null
  noise_verdict_source?: string | null
}

describe('归类结果与 item 的对齐（needs_review / noise_term 不能错位）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'align')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (input: string) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: { input } })

  /** 落库的 parsed_items 是**裁剪前**的完整 items，出参只回一笔 */
  function storedItems(): StoredItem[] {
    const row = getDb()
      .prepare('SELECT parsed_items FROM ai_parse_logs ORDER BY id DESC LIMIT 1')
      .get() as { parsed_items: string }
    return JSON.parse(row.parsed_items) as StoredItem[]
  }

  it('三笔混合：噪声字段与 needs_review 各自挂在正确的那一笔上', async () => {
    mockState.reply = MIXED_ITEMS
    const res = await post('闪购红包未查收，另有一笔午饭已支付32.00元，微信转支付宝100.00元')
    expect(JSON.parse(res.payload).code).toBe(0)

    const items = storedItems()
    expect(items).toHaveLength(3)
    const byDesc = new Map(items.map((i) => [i.description, i]))

    const noise = byDesc.get('被噪声闸拦下')!
    expect(noise.category_id).toBeNull()
    expect(noise.category_reason).toBe('noise_word')
    expect(noise.noise_term).toBe('红包')
    expect(noise.needs_review).toBe(true)

    // transfer：不参与归类 → 没有 noise 字段、categoryExact 恒 true（不该被噪声闸/分类牵连）
    const transfer = byDesc.get('微信转支付宝')!
    expect(transfer.type).toBe('transfer')
    expect(transfer.noise_term).toBeUndefined()
    expect(transfer.noise_verdict_source).toBeUndefined()
    expect(transfer.needs_review).toBe(false)

    const meal = byDesc.get('午饭')!
    expect(meal.category_name).toBe('餐饮')
    expect(meal.category_reason).toBeUndefined() // 非噪声判例不塞这三个字段
    expect(meal.needs_review).toBe(false)
  })

  it('噪声闸只影响**那一笔**，不牵连同一批的其他笔', async () => {
    mockState.reply = MIXED_ITEMS
    await post('闪购红包未查收，另有一笔午饭已支付32.00元，微信转支付宝100.00元')
    const items = storedItems()
    // 只有 description=被噪声闸拦下 的那一笔带 noise_term
    const withNoise = items.filter((i) => i.noise_term !== undefined && i.noise_term !== null)
    expect(withNoise).toHaveLength(1)
    expect(withNoise[0]!.description).toBe('被噪声闸拦下')
    // 且 needs_review=true 的也只有需要它的那几笔（噪声那笔 + 无佐证的）
    expect(items.find((i) => i.description === '午饭')!.needs_review).toBe(false)
  })

  it('出参仍只回一笔（对齐改造没有改变「一次解析只回一笔」的契约）', async () => {
    mockState.reply = MIXED_ITEMS
    const res = await post('闪购红包未查收，另有一笔午饭已支付32.00元，微信转支付宝100.00元')
    const body = JSON.parse(res.payload)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.extra_items_dropped).toBe(2)
    // 选中的是金额最大的那笔（微信转支付宝 100.00 元）
    expect(body.data.items[0].description).toBe('微信转支付宝')
    // 响应形状没变：既有键一字不改
    expect(body.data.items[0]).not.toHaveProperty('resolution')
  })
})