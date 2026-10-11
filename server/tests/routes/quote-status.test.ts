/**
 * 行情状态要**从数据里算**并随列表返回。
 *
 * 之前前端只在手动刷新时记一个 ref，于是页面一打开就显示「行情未获取过」，
 * 哪怕库里早有行情——用户根本看不到「上一次刷新时间」。
 *
 * 上游走离线夹具（`tests/offline-quotes.ts`）：目录里认得 sh518880 与 hk00700，
 * 不认 hk0100 —— 所以「2 个持仓只有 1 个取到价」是**夹具决定的**，
 * 不再取决于当天腾讯在不在。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { resetFxBackfillState } from '../../src/lib/quote-acquisition.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  // 工厂会被提升到文件顶部，不能直接引用文件顶部的 import（TDZ）——运行时再拿。
  // 包一层 vi.fn：默认行为就是离线 provider，用例可以数它被打过几次。
  const { offlineFetchQuotes } = await import('../offline-quotes.js')
  return { ...actual, fetchQuotes: vi.fn(offlineFetchQuotes) }
})

describe('行情状态随列表返回', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'qstatus')
  })
  afterAll(async () => { await teardownApp(app) })

  it('没有持仓时状态为空，不报错', async () => {
    const d = JSON.parse((await app.inject({
      method: 'GET', url: '/api/investments', headers: authHeaders(token),
    })).payload).data
    expect(d.quote.totalCount).toBe(0)
    expect(d.quote.lastAt).toBeNull()
    expect(d.quote.schedule).toHaveProperty('fetch')
  })

  it('有持仓且取到价后，lastAt 反映**数据里的**更新时间', async () => {
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: authHeaders(token),
      payload: { name: '券商', type: 'other', asset_type: 'investment' },
    })).payload).data
    // 新增持仓会顺带自动取价（mock 返回固定时间戳）
    await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(token),
      payload: { account_id: acc.id, code: '518880', quantity: 100 },
    })
    const d = JSON.parse((await app.inject({
      method: 'GET', url: '/api/investments', headers: authHeaders(token),
    })).payload).data
    expect(d.quote.lastAt).toBe('2026-10-09 16:14:56') // 来自库里，不是前端记的
    expect(d.quote.lastDate).toBe('2026-10-09')
    expect(d.quote.pricedCount).toBe(1)
    expect(d.quote.totalCount).toBe(1)
  })

  /**
   * 列表接口的汇率自愈是 **fire-and-forget**：它必须不阻塞、不改变响应契约，
   * 也不能每次进来都把上游打一遍（否则一个缺汇率的用户就是请求放大器）。
   * 这里只锁对外契约：响应照常返回，缺汇率不是错误。
   */
  it('缺汇率时列表照常返回（自愈不阻塞、不改变响应契约）', async () => {
    // 单独一个用户：否则多出来的持仓会污染下一条用例的 pricedCount 断言
    const own = await createUser(app, 'qstatus_fx')
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: authHeaders(own),
      payload: { name: '港股户', type: 'other', asset_type: 'investment' },
    })).payload).data
    await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(own),
      payload: { account_id: acc.id, code: 'hk00700', quantity: 100 },
    })
    const res = JSON.parse((await app.inject({
      method: 'GET', url: '/api/investments', headers: authHeaders(own),
    })).payload)
    expect(res.code).toBe(0)
    const item = res.data.items.find((x: any) => x.code === 'hk00700')!
    expect(item.currency).toBe('HKD')
    expect(item.marketValueNative).toBeGreaterThan(0)     // 原币市值照算
    expect(item.fxRate).toBeCloseTo(0.8525, 6)            // 后台自愈补上的汇率
    expect(item.marketValue).toBe(Math.round(item.marketValueNative! * 0.8525))
  })

  /**
   * **自愈必须是有界的**：它跑在每次 GET 上，没有闸门的话，
   * 一个缺汇率的用户每刷一次页面就向上游发一次请求——而这个上游和定时任务
   * 共用同一个出口 IP 和同一个非官方接口，拖垮的是全局行情。
   *
   * 这里锁两件事：上游只被打一次，且**响应一次都没被拖慢**（fire-and-forget）。
   */
  it('自愈有界：上游一直补不上时，连刷三次也只打一次，且响应不受影响', async () => {
    resetFxBackfillState()                       // 模块级闸门状态跨用例共享，先清干净
    const own = await createUser(app, 'qstatus_bounded')
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: authHeaders(own),
      payload: { name: '港币户', type: 'other', asset_type: 'investment' },
    })).payload).data
    await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(own),
      payload: { account_id: acc.id, code: 'hk00700', quantity: 100 },
    })
    await new Promise((r) => setTimeout(r, 20))   // 让 POST 的后台汇率请求先落定

    // 汇率是**全局数据**（loadLatestFxRates 不按用户查），而且只要库里有行，
    // 自愈就判定「不缺」——所以清库，否则这条什么都测不到。
    getDb().prepare("DELETE FROM investment_quotes WHERE code LIKE 'wh%CNY'").run()

    const { offlineFetchQuotes } = await import('../offline-quotes.js')
    const quotes = vi.mocked(await import('../../src/lib/quotes.js'))
    // 兜底源也自己接管：主源挂了会落到 ECB，不接管就会真外发（守卫会判红）。
    // 注意这条报错**是本用例自己的 stub 抛的**，不是 setup.ts 的外发守卫——
    // 它只用来保证「ECB 这一路也算失败」。
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      throw new Error(`ECB 兜底源被本用例接管（不发真实请求）：${String(input?.url ?? input)}`)
    }))
    // 让汇率**一直**补不上：这才是放大器真正会出事的场景（失败 → 用户继续刷 → 还打）
    quotes.fetchQuotes.mockImplementation(async (codes: string[]) => {
      if (codes.some((c) => c.startsWith('wh'))) throw new Error('行情接口返回空')
      return offlineFetchQuotes(codes)
    })
    quotes.fetchQuotes.mockClear()
    // 拿掉历史 fx 日志，好只数本用例产生的
    getDb().prepare("DELETE FROM app_logs WHERE module = 'fx'").run()
    const fxAttempts = () =>
      quotes.fetchQuotes.mock.calls.filter((c) =>
        (c[0] as string[]).some((code) => code.startsWith('wh'))).length
    const fxLogRows = () => (getDb()
      .prepare("SELECT count(*) c FROM app_logs WHERE module = 'fx'").get() as { c: number }).c

    try {
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'GET', url: '/api/investments', headers: authHeaders(own),
        })
        expect(res.statusCode).toBe(200)          // 每次都照常返回，不排队等上游
      }
      expect(fxAttempts()).toBe(1)                // 三次刷新只发一次（冷却闸门）

      // M3：**被闸门挡下不算事件**。三次里只有第一次真的去取过，
      // 所以日志只能有一行（那一次的结果）。否则 app_logs 会变成
      // 「用户每刷一次投资页就加一行跳过日志」的流水账。
      expect(fxLogRows()).toBe(1)
      expect(fxAttempts()).toBe(1)
    } finally {
      quotes.fetchQuotes.mockImplementation(offlineFetchQuotes)
      resetFxBackfillState()
      vi.unstubAllGlobals()
    }
  })

  it('取不到价的标的会让 pricedCount < totalCount（前端据此说「2/3 个」）', async () => {
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: authHeaders(token),
      payload: { name: '券商2', type: 'other', asset_type: 'investment' },
    })).payload).data
    // mock 只会返回 sh518880，所以 hk0100 永远取不到
    await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(token),
      payload: { account_id: acc.id, code: 'hk0100', quantity: 50 },
    })
    const d = JSON.parse((await app.inject({
      method: 'GET', url: '/api/investments', headers: authHeaders(token),
    })).payload).data
    expect(d.quote.totalCount).toBe(2)
    expect(d.quote.pricedCount).toBe(1)
  })
})
