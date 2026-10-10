/**
 * 行情状态要**从数据里算**并随列表返回。
 *
 * 之前前端只在手动刷新时记一个 ref，于是页面一打开就显示「行情未获取过」，
 * 哪怕库里早有行情——用户根本看不到「上一次刷新时间」。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  return {
    ...orig,
    fetchQuotes: vi.fn(async () => [{
      code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
      changeRate: 1.3, quoteDate: '2026-10-09', quoteAt: '2026-10-09 16:14:56',
    }]),
  }
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
