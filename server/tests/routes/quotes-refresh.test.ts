/**
 * 手动刷新行情 + 反馈。
 *
 * 之前「未取到价」是个死胡同：定时抓取有交易时段门禁（周末/夜间静默跳过），
 * 页面既不说为什么，也不给任何入口，用户只能干等。这个端点就是补上那个入口，
 * 并且**如实回报每个代码的结果**——拿不到的要说清原因，不能静默跳过。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  // 只回 sh518880 一个，模拟「hk0100 腾讯不认」
  return {
    ...orig,
    fetchQuotes: vi.fn(async (codes: string[]) => {
      if (!Array.isArray(codes)) return []
      return codes
        .filter((c) => c === 'sh518880')
        .map(() => ({
          code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
          changeRate: 1.3, quoteDate: '2026-10-09', quoteAt: '2026-10-09 16:14:56',
        }))
    }),
  }
})

describe('手动刷新行情', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'quoterefresh')
    // 建一个理财账户 + 一条好代码 + 一条坏代码
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts',
      headers: authHeaders(token),
      payload: { name: '券商', type: 'other', asset_type: 'investment' },
    })).payload).data
    for (const code of ['sh518880', 'hk0100']) {
      await app.inject({
        method: 'POST', url: '/api/investments',
        headers: authHeaders(token),
        payload: { account_id: acc.id, code, name: code, quantity: 100 },
      })
    }
  })
  afterAll(async () => { await teardownApp(app) })

  it('没有持仓时刷新，不报错且明确说无需刷新', async () => {
    const emptyTok = await createUser(app, 'quoterefresh_empty')
    const r = await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(emptyTok), payload: {},
    })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.payload)
    expect(body.code).toBe(0)
    expect(body.data.total).toBe(0)
    expect(body.message).toContain('无需刷新')
  })

  it('逐个回报结果：取到的给价，取不到的给原因（不静默）', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(token), payload: {},
    })
    expect(r.statusCode).toBe(200)
    const d = JSON.parse(r.payload).data

    expect(d.total).toBe(2)
    expect(d.fetched).toBe(1)              // 只有 sh518880 拿到
    expect(d.network).toBe(true)           // 网络是通的，问题在代码

    const ok = d.results.find((x: any) => x.code === 'sh518880')!
    expect(ok.ok).toBe(true)
    expect(ok.price).toBe(8.617)
    // 行情日期来自市场自己，不是「今天」——不伪造新鲜度
    expect(ok.quoteDate).toBe('2026-10-09')

    const bad = d.results.find((x: any) => x.code === 'hk0100')!
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('腾讯不认')  // 原因要具体，不能只说「失败」
  })

  it('把不认的代码列在 missing 里，让前端能点名报错', async () => {
    const d = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(token), payload: {},
    })).payload).data
    expect(d.missing).toHaveLength(1)
    expect(d.missing[0].code).toBe('hk0100')
    expect(d.missing[0].reason).toContain('腾讯不认')
  })

  it('拿到的行情确实落库了（刷新不只是响应回显）', async () => {
    await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(token), payload: {},
    })
    const { getDb } = await import('../../src/db/index.js')
    const row = getDb()
      .prepare("SELECT count(*) c FROM investment_quotes WHERE code = 'sh518880'")
      .get() as { c: number }
    expect(row.c).toBeGreaterThan(0)
  })

  it('回报调度状态，让前端能解释「为什么没有自动更新」', async () => {
    const d = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(token), payload: {},
    })).payload).data
    expect(d.schedule).toHaveProperty('fetch')
    expect(d.schedule).toHaveProperty('reason')
    expect(typeof d.at).toBe('string')
  })

  it('只能刷自己的持仓，不串味', async () => {
    const other = await createUser(app, 'quoterefresh_other')
    const d = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(other), payload: {},
    })).payload).data
    expect(d.total).toBe(0)   // 别人的持仓不算进来
  })
})