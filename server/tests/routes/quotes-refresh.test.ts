/**
 * 手动刷新行情 + 反馈。
 *
 * 之前「未取到价」是个死胡同：定时抓取有交易时段门禁（周末/夜间静默跳过），
 * 页面既不说为什么，也不给任何入口，用户只能干等。这个端点就是补上那个入口，
 * 并且**如实回报每个代码的结果**——拿不到的要说清原因，不能静默跳过。
 *
 * 上游全部走离线夹具（`tests/offline-quotes.ts`）：目录里有 sh518880 和
 * whHKDCNY，**没有 hk0100** —— 正好复刻「腾讯不认这个代码」，
 * 而汇率那条兜底链（主源 → ECB）也会真的跑一遍。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  // 工厂会被提升到文件顶部，不能直接引用文件顶部的 import（TDZ）——运行时再拿。
  // 包一层 vi.fn：默认行为就是离线 provider，测试可以临时改成「上游挂了」。
  const { offlineFetchQuotes } = await import('../offline-quotes.js')
  return { ...actual, fetchQuotes: vi.fn(offlineFetchQuotes) }
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

  it('汇率跟着一起取，并如实报出来源（外币持仓要折人民币）', async () => {
    const d = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(token), payload: {},
    })).payload).data

    // hk0100 的币种是 HKD → 刷新时要顺带取 whHKDCNY
    expect(d.fx.HKD).toBeCloseTo(0.8525, 6)
    expect(d.fxSource).toBe('tencent')      // 主源认得这个币种，不该走兜底

    // 汇率行也落库了（和股价同表、带真实来源）
    const { getDb } = await import('../../src/db/index.js')
    const row = getDb()
      .prepare("SELECT price, source FROM investment_quotes WHERE code = 'whHKDCNY'")
      .get() as { price: number; source: string }
    expect(row.price).toBeCloseTo(0.8525, 6)
    expect(row.source).toBe('tencent')
  })

  it('上游真挂了：逐码报「连不上」而不是混成「代码不认」，且不写任何行情', async () => {
    const { getDb } = await import('../../src/db/index.js')
    const { offlineFetchQuotes } = await import('../offline-quotes.js')
    const quotes = vi.mocked(await import('../../src/lib/quotes.js'))
    const countBefore = (getDb()
      .prepare("SELECT count(*) c FROM investment_quotes WHERE code IN ('sh518880','hk0100')")
      .get() as { c: number }).c

    // 只让**股价**那一次挂掉；汇率照常（走主源，不碰兜底源，也就不会外发）
    quotes.fetchQuotes.mockImplementation(async (codes) => {
      if (!codes.every((c) => c.startsWith('wh'))) throw new Error('行情接口返回 503')
      return offlineFetchQuotes(codes)
    })
    try {
      const r = await app.inject({
        method: 'POST', url: '/api/investments/quotes/refresh',
        headers: authHeaders(token), payload: {},
      })
      const d = JSON.parse(r.payload).data

      // 响应契约（已发布端点）一字不改
      expect(r.statusCode).toBe(200)
      expect(d.network).toBe(false)
      expect(d.results).toEqual([])
      expect(d.fx).toEqual({})
      expect(d.fxSource).toBe('none')
      expect(d.missing).toHaveLength(d.total)
      expect(d.missing[0].reason).toBe('行情接口连不上，稍后再试')
      expect(JSON.parse(r.payload).message).toBe('行情接口连不上，稍后再试')
      expect(d.fetched).toBe(0)

      // 「失败不写任何行情」：写一条错价比不写更危险
      const countAfter = (getDb()
        .prepare("SELECT count(*) c FROM investment_quotes WHERE code IN ('sh518880','hk0100')")
        .get() as { c: number }).c
      expect(countAfter).toBe(countBefore)
    } finally {
      quotes.fetchQuotes.mockImplementation(offlineFetchQuotes)   // 别污染后面的用例
    }
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

  /**
   * 只有 A 股持仓的用户，不能被告知「美股时段」——时段必须按**该用户实际持有的
   * 持仓**算。以前这里无参调用 `shouldFetchQuotes()`，默认 `['cn']`，
   * 于是只持港股/美股的用户拿到的解释永远是 A 股时段（见 issue：刷新页时段错位）。
   * 响应字段本身不动（已发布端点），只把它算对。
   */
  it('schedule 按该用户**实际持仓**的市场算，不是固定 A 股', async () => {
    const usTok = await createUser(app, 'quoterefresh_us')
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts',
      headers: authHeaders(usTok),
      payload: { name: '美股户', type: 'other', asset_type: 'investment' },
    })).payload).data
    await app.inject({
      method: 'POST', url: '/api/investments',
      headers: authHeaders(usTok),
      payload: { account_id: acc.id, code: 'usAAPL', quantity: 10 },
    })

    // 把时间钉在「A股已收、美股盘中」（北京 22:00 = UTC 14:00）
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T14:00:00Z'))
    const d = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments/quotes/refresh',
      headers: authHeaders(usTok), payload: {},
    })).payload).data
    vi.useRealTimers()

    expect(d.total).toBe(1)
    expect(d.schedule.fetch).toBe(true)
    expect(d.schedule.reason).toContain('美股')
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
