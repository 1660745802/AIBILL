/**
 * 持仓 CRUD + 估值路由测试
 *
 * 行情用真实夹具（quotes-sample.txt 里 sh518880 @ 8.617）直接写进 investment_quotes，
 * **不联网**。上游 provider 也 mock 掉（`tests/offline-quotes.ts`）——
 * 之前这条文件是真连腾讯的：「新增持仓后自动取价」断言的是**活价**，
 * 网络一断就红。现在它断言的是「取价被发起且结果落库」，离线且确定。
 *
 * 覆盖：normalize、账户归属校验、估值（含行情缺失→null 不编 0）、软删。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { parseQuoteResponse } from '../../src/lib/quotes.js'
import { offlineFetchQuotes, resetOfflineFlags } from '../offline-quotes.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  // 工厂会被提升到文件顶部，不能直接引用文件顶部的 import（TDZ）——运行时再拿
  const { offlineFetchQuotes } = await import('../offline-quotes.js')
  return { ...actual, fetchQuotes: vi.fn(offlineFetchQuotes) }   // 包一层：用例要数请求/改实现
})

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = readFileSync(join(HERE, '../fixtures/quotes-sample.txt'), 'utf-8')
const GOLD = parseQuoteResponse(SAMPLE).find((q) => q.code === 'sh518880')! // 现价 8.617

function seedQuote() {
  getDb().prepare(
    `INSERT OR IGNORE INTO investment_quotes (code, name, price, prev_close, change_rate, quote_date, quoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(GOLD.code, GOLD.name, GOLD.price, GOLD.prevClose, GOLD.changeRate, GOLD.quoteDate, GOLD.quoteAt)
}

describe('持仓 CRUD · /api/investments', () => {
  let app: FastifyInstance
  let token: string
  let otherToken: string
  let secAccId: number
  let foreignAccId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'inv_user')
    otherToken = await createUser(app, 'inv_other')

    const accs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items as Array<{ id: number; name: string }>
    secAccId = accs.find((a) => a.name === '银行卡')!.id
    getDb().prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(secAccId)

    foreignAccId = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(otherToken) })).payload,
    ).data.items[0].id

    seedQuote()
  })

  afterAll(async () => { resetOfflineFlags(); await teardownApp(app) })

  let createdId: number

  it('POST 新增：code 自动 normalize（518880 → sh518880）', async () => {
    const res = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: secAccId, code: '518880', name: '黄金ETF', quantity: 10000 },
      })).payload,
    )
    expect(res.code).toBe(0)
    expect(res.data.code).toBe('sh518880')   // normalize 生效
    expect(res.data.market).toBe('sh')
    // 单只不再有成本字段（本轮删除项）
    expect(res.data).not.toHaveProperty('cost_basis')
    createdId = res.data.id
  })

  it('POST 接受 518880.SH 这种带点后缀写法', async () => {
    const res = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: secAccId, code: '159937.SZ', quantity: 500 },
      })).payload,
    )
    expect(res.code).toBe(0)
    expect(res.data.code).toBe('sz159937')
    // 清掉这条，避免污染后面估值断言（它没行情）
    await app.inject({ method: 'DELETE', url: `/api/investments/${res.data.id}`, headers: authHeaders(token) })
  })

  it('POST 拒绝给别人的账户挂持仓', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(token),
      payload: { account_id: foreignAccId, code: '518880', quantity: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2001)
  })

  it('POST 同账户同 code 唯一，重复报 3001', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(token),
      payload: { account_id: secAccId, code: 'sh518880', quantity: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(3001)
  })

  it('GET 列出持仓并用最新行情估值（10000 × 8.617 = ¥86,170）', async () => {
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
    )
    expect(res.code).toBe(0)
    const item = res.data.items.find((x: any) => x.id === createdId)
    expect(item.marketValue).toBe(8617000)       // 市值 = 10,000 × 8.617 元
    expect(item.quote.price).toBe(8.617)
    // 单只不算盈亏：这两个字段本轮删掉了，别再出现
    expect(item).not.toHaveProperty('costPrice')
    expect(item).not.toHaveProperty('unrealized')
    // 汇总也不在这里算 —— 账户级读数归 /api/assets/portfolio（避免两处算同一个浮盈而漂移）
    expect(res.data).not.toHaveProperty('summary')
  })

  it('GET 行情缺失时 marketValue=null，不编 0', async () => {
    // 新挂一个**腾讯不认**的代码（真实踩过的：hk0100）。
    // 注意不能用真实代码——POST 现在会自动取价，用真代码会当场拿到行情，
    // 那样这个用例测的就不再是「缺失」了。
    const add = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: secAccId, code: 'hk0100', quantity: 2000 },
      })).payload,
    )
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
    )
    const noQuote = res.data.items.find((x: any) => x.id === add.data.id)
    expect(noQuote.marketValue).toBeNull()   // 不是 0 —— 0 会被读成"归零了"
    expect(noQuote.valued).toBe(false)
    expect(noQuote.quote).toBeNull()
    await app.inject({ method: 'DELETE', url: `/api/investments/${add.data.id}`, headers: authHeaders(token) })
  })

  it('新增持仓后自动取价——不该还要手动刷新', async () => {
    // 这是用户直接提的：「我更新持仓的时候你不能自动获取最新信息吗」。
    // 加完就该看到价，不该显示「待取价」。
    const add = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: secAccId, code: 'hk00700', quantity: 100 },
      })).payload,
    )
    expect(add.code, `POST 失败: ${add.message}`).toBe(0)
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
    )
    const row = res.data.items.find((x: any) => x.id === add.data.id)!
    // 离线 provider 的夹具值（hk00700 @ 424.800）
    expect(row.quote).not.toBeNull()        // 刚加完就有行情，不用手动刷新
    expect(row.quote.price).toBe(424.8)
    expect(row.marketValueNative).toBe(Math.round(100 * 424.8 * 100))
    expect(row.valued).toBe(true)
    // 外币持仓还要顺带补汇率（whHKDCNY 走主源）——折算后才是人民币市值
    expect(row.currency).toBe('HKD')
    expect(row.fxRate).toBeCloseTo(0.8525, 6)
    expect(row.marketValue).toBe(Math.round(row.marketValueNative * 0.8525))
    await app.inject({ method: 'DELETE', url: `/api/investments/${add.data.id}`, headers: authHeaders(token) })
  })

  /**
   * 主源拿不到汇率时（腾讯 fx 端点挂掉），自动取价**不能把写入搞挂**，
   * 而且必须**走到 ECB 兜底**——以前这里是直接问腾讯要 `wh*CNY`，
   * 腾讯一挂就永远拿不到汇率，整条折算链路静默失效。
   * 兜底源同样不可用时：持仓照建、响应照旧「已添加持仓」，只是暂时「待补汇率」。
   */
  /**
   * **并发**：股价与外币汇率两段都是网络等待。
   * 串行时「汇率那一次」只能在股价请求**返回之后**才发起，最坏耗时相加
   * （8s + 8s + 8s = 24s）；POST 是阻塞返回的，用户直接感到卡。
   *
   * 判据不是掐表（会抖），而是看**发起顺序**：汇率请求必须在股价请求
   * 还没回来的时候就被发出去。
   */
  it('外币持仓：股价与汇率并发发起（汇率不等股价先回来）', async () => {
    const quotes = vi.mocked(await import('../../src/lib/quotes.js'))
    let priceDone = false
    let fxStartedWhilePriceInFlight = false
    quotes.fetchQuotes.mockImplementation(async (codes: string[]) => {
      if (codes.every((c) => c.startsWith('wh'))) {        // 汇率那一次
        if (!priceDone) fxStartedWhilePriceInFlight = true
        return offlineFetchQuotes(codes)
      }
      await new Promise((r) => setTimeout(r, 60))          // 股价慢一点
      priceDone = true
      return offlineFetchQuotes(codes)
    })
    priceDone = false
    try {
      const acc = JSON.parse((await app.inject({
        method: 'POST', url: '/api/accounts', headers: authHeaders(token),
        payload: { name: '并发用账户', type: 'other', asset_type: 'investment' },
      })).payload).data
      const add = JSON.parse((await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: acc.id, code: 'hk00700', quantity: 50 },
      })).payload)
      // 成功响应契约不变
      expect(add.code, `POST 失败: ${add.message}`).toBe(0)
      expect(fxStartedWhilePriceInFlight).toBe(true)       // 串行时这里是 false
      await app.inject({ method: 'DELETE', url: `/api/investments/${add.data.id}`, headers: authHeaders(token) })
    } finally {
      quotes.fetchQuotes.mockImplementation(offlineFetchQuotes)
    }
  })

  /** CNY-only 的持仓**不该**为汇率多发一次请求 */
  it('CNY-only 持仓不发起汇率请求', async () => {
    const quotes = vi.mocked(await import('../../src/lib/quotes.js'))
    quotes.fetchQuotes.mockClear()
    const acc = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: authHeaders(token),
      payload: { name: 'A股户', type: 'other', asset_type: 'investment' },
    })).payload).data
    const add = JSON.parse((await app.inject({
      method: 'POST', url: '/api/investments', headers: authHeaders(token),
      payload: { account_id: acc.id, code: 'sh000300', quantity: 300 },
    })).payload)
    expect(add.code, `POST 失败: ${add.message}`).toBe(0)
    const calls = quotes.fetchQuotes.mock.calls.map((c) => c[0] as string[])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((cs) => cs.some((x) => x.startsWith('wh')))).toBe(false)
    await app.inject({ method: 'DELETE', url: `/api/investments/${add.data.id}`, headers: authHeaders(token) })
  })

  it('主源没有汇率时落到 ECB 兜底；兜底也没有也绝不阻塞写入', async () => {
    process.env.OFFLINE_NO_FX = '1'
    const ecb = vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes('frankfurter')) {
        return new Response(JSON.stringify({ date: '2026-10-09', rates: { USD: 0.14943 } }), { status: 200 })
      }
      throw new Error(`[测试守卫] 禁止真实外发：${url}`)
    })
    vi.stubGlobal('fetch', ecb)
    try {
      const add = JSON.parse(
        (await app.inject({
          method: 'POST', url: '/api/investments', headers: authHeaders(token),
          payload: { account_id: secAccId, code: 'usAAPL', quantity: 10 },
        })).payload,
      )
      // 现有契约：阻塞返回 + 吞错 = POST 仍然成功
      expect(add.code, `POST 失败: ${add.message}`).toBe(0)

      const res = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
      )
      const row = res.data.items.find((x: any) => x.id === add.data.id)!
      expect(row.quote.price).toBe(336.64)         // 股价照样取到（夹具里的 usAAPL）
      expect(row.currency).toBe('USD')
      // ECB 返回的是「1 CNY = 多少外币」，要取倒数：1 / 0.14943 ≈ 6.692
      expect(ecb).toHaveBeenCalled()             // 真的走了兜底源
      expect(row.fxRate).toBeCloseTo(1 / 0.14943, 4)
      // **来源必须是真的**：兜底源拿到的汇率不能被硬编码成 tencent
      const fxRow = getDb()
        .prepare("SELECT source FROM investment_quotes WHERE code = 'whUSDCNY'")
        .get() as { source: string }
      expect(fxRow.source).toBe('ecb')

      await app.inject({ method: 'DELETE', url: `/api/investments/${add.data.id}`, headers: authHeaders(token) })

      // 再来一个「兜底也挂了」：写入与响应契约不变，只是暂时没汇率。
      // 先清掉已有汇率行（本文件前面的用例已经写过 wh*CNY），换一个币种不顶用。
      getDb().prepare("DELETE FROM investment_quotes WHERE code LIKE 'wh%CNY'").run()
      ecb.mockImplementation(async (input: any) => {
        const url = String(input?.url ?? input)
        if (url.includes('frankfurter')) throw new Error('ECB 挂了')
        throw new Error(`[测试守卫] 禁止真实外发：${url}`)
      })
      const add2 = JSON.parse(
        (await app.inject({
          method: 'POST', url: '/api/investments', headers: authHeaders(token),
          payload: { account_id: secAccId, code: 'hk00700', quantity: 200 },
        })).payload,
      )
      expect(add2.code).toBe(0)
      const res2 = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
      )
      const row2 = res2.data.items.find((x: any) => x.id === add2.data.id)!
      expect(row2.quote).not.toBeNull()            // 股价还在
      expect(row2.fxRate).toBeNull()               // 汇率没有
      expect(row2.marketValue).toBeNull()          // 不折算也不编数
      expect(row2.marketValueNative).toBeGreaterThan(0)
      await app.inject({ method: 'DELETE', url: `/api/investments/${add2.data.id}`, headers: authHeaders(token) })
    } finally {
      vi.unstubAllGlobals()
      resetOfflineFlags()
    }
  })

  it('PATCH 改股数 → 市值立刻跟着重算（加减仓只动股数）', async () => {
    await app.inject({
      method: 'PATCH', url: `/api/investments/${createdId}`, headers: authHeaders(token),
      payload: { quantity: 12500 },
    })
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
    )
    const item = res.data.items.find((x: any) => x.id === createdId)
    expect(item.quantity).toBe(12500)
    expect(item.marketValue).toBe(Math.round(12500 * 8.617 * 100))   // 市值随股数走
  })

  it('软删之后能再加回来（唯一约束不看 is_active，必须走复活）', async () => {
    // 先删掉 createdId
    await app.inject({ method: 'DELETE', url: `/api/investments/${createdId}`, headers: authHeaders(token) })
    // 再加同一个 code：直接 INSERT 会被 UNIQUE(user_id, account_id, code) 挡下
    const res = JSON.parse(
      (
        await app.inject({
          method: 'POST', url: '/api/investments', headers: authHeaders(token),
          payload: { account_id: secAccId, code: '518880', quantity: 500 },
        })
      ).payload,
    )
    expect(res.code).toBe(0)
    // 复活同一行，不是新建
    expect(res.data.id).toBe(createdId)
    expect(res.data.quantity).toBe(500)
    expect(res.data.is_active).toBe(1)
  })

  it('PATCH 拒绝改别人的持仓（404）', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/investments/${createdId}`, headers: authHeaders(otherToken),
      payload: { quantity: 1 },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.payload).code).toBe(3002)
  })

  it('DELETE 软删（is_active=0，不物理删，保留历史）', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/api/investments/${createdId}`, headers: authHeaders(token) })
    expect(del.statusCode).toBe(200)
    expect(JSON.parse(del.payload).code).toBe(0)
    // 列表里不再出现
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/investments', headers: authHeaders(token) })).payload,
    )
    expect(res.data.items.find((x: any) => x.id === createdId)).toBeUndefined()
    // 但行还在（软删）
    const row = getDb().prepare('SELECT is_active FROM investments WHERE id=?').get(createdId) as { is_active: number }
    expect(row.is_active).toBe(0)
  })

  it('DELETE 不存在的持仓返回 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/investments/999999', headers: authHeaders(token) })
    expect(res.statusCode).toBe(404)
  })
})
