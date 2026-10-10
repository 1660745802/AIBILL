/**
 * 持仓 CRUD + 估值路由测试
 *
 * 行情用真实夹具（quotes-sample.txt 里 sh518880 @ 8.617）直接写进 investment_quotes，
 * 不联网。覆盖：normalize、账户归属校验、估值（含行情缺失→null 不编 0）、软删。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { parseQuoteResponse } from '../../src/lib/quotes.js'

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

  afterAll(async () => { await teardownApp(app) })

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
    // 新挂一个没有行情的标的
    const add = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/investments', headers: authHeaders(token),
        payload: { account_id: secAccId, code: 'sz159915', quantity: 2000 },
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
