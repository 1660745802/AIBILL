/**
 * 账户的「增加 / 删除」（用户口径：不是停用/启用）。
 *
 * 删什么留什么是有讲究的：
 *   删  · 账户本身（软删，可还原）
 *   删  · 该账户的余额快照和持仓（派生数据）
 *   留  · **流水**——账本事实，而且有真实外键，删不掉也不该删。
 *        用户原话：「账单没漏就行」。
 *
 * 另外：新建账户时必须能一次选对类型（活期/定期/理财投资/信用卡等），
 * 否则要建完再去资产页改一遍——同一个设置两个入口，第二个藏得最深。
 *
 * 本文件会 POST 持仓，而 POST 会自动取价——所以上游必须 mock 掉，
 * 否则它在偷偷连腾讯（已被 tests/setup.ts 的外发守卫拓出来）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/quotes.js')>()
  // 工厂会被提升到文件顶部，不能直接引用文件顶部的 import（TDZ）——运行时再拿
  const { offlineFetchQuotes } = await import('../offline-quotes.js')
  return { ...actual, fetchQuotes: offlineFetchQuotes }
})

describe('账户的增加与删除', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'acctcrud')
  })
  afterAll(async () => { await teardownApp(app) })

  const post = (p: string, payload: unknown) =>
    app.inject({ method: 'POST', url: p, headers: authHeaders(token), payload })
  const del = (p: string) => app.inject({ method: 'DELETE', url: p, headers: authHeaders(token) })

  const list = async () => {
    const { data } = JSON.parse(
      (await app.inject({
        method: 'GET', url: '/api/accounts',
        headers: authHeaders(token), query: { include_inactive: '1' },
      })).payload,
    )
    return data.items as any[]
  }

  it('新建账户时可以直接选「理财投资」，不用再建完去别处改', async () => {
    const res = await post('/api/accounts', {
      name: '券商账户', type: 'other', icon: '📈',
      asset_type: 'investment', initial_balance: 500000,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).code).toBe(0)

    const acc = (await list()).find((a) => a.name === '券商账户')!
    expect(acc.asset_type).toBe('investment')
    expect(acc.current_balance).toBe(500000) // 建完就能在资产页看到
  })

  it('所有账户类型都能建', async () => {
    for (const t of ['liquid', 'savings', 'credit', 'loan', 'property', 'other']) {
      const res = await post('/api/accounts', { name: `T-${t}`, type: 'other', asset_type: t })
      expect(JSON.parse(res.payload).code, t).toBe(0)
      expect((await list()).find((a) => a.name === `T-${t}`)!.asset_type).toBe(t)
    }
  })

  it('删除账户：账单全部保留，只是不再计入余额', async () => {
    const created = JSON.parse((await post('/api/accounts', {
      name: '要删的账户', type: 'other', asset_type: 'liquid', initial_balance: 1000,
    })).payload).data
    const id = created.id

    // 记两笔有归属的账单
    for (const amt of [300, 200]) {
      await post('/api/transactions', {
        items: [{ type: 'expense', amount: amt, date: '2099-01-01', description: 'x', account_id: id }],
      })
    }

    const before = (await list()).find((a) => a.id === id)!
    expect(before.current_balance).toBe(1000 - 500)

    const delRes = await del(`/api/accounts/${id}`)
    expect(delRes.statusCode).toBe(200)
    const body = JSON.parse(delRes.payload)
    expect(body.code).toBe(0)
    expect(body.data.transactions).toBe(2) // 如实告知有 2 笔账单

    // 从活跃列表消失
    expect((await list()).find((a) => a.id === id)?.is_active).toBe(0)
  })

  it('删除账户不删除它的账单（账单优先于账户整洁）', async () => {
    const created = JSON.parse((await post('/api/accounts', { name: '留账单', type: 'other' })).payload).data
    await post('/api/transactions', {
      items: [{ type: 'expense', amount: 888, date: '2099-02-02', description: '保留我', account_id: created.id }],
    })
    await del(`/api/accounts/${created.id}`)

    // 账单还在流水里
    const txns = JSON.parse((await app.inject({
      method: 'GET', url: '/api/transactions', headers: authHeaders(token), query: { pageSize: '200' },
    })).payload).data.items as any[]
    expect(txns.some((t) => t.description === '保留我')).toBe(true)
  })

  it('删除账户会清掉它的余额快照和持仓（派生数据不留在已删账户名下）', async () => {
    const created = JSON.parse((await post('/api/accounts', {
      name: '带持仓的', type: 'other', asset_type: 'investment',
    })).payload).data
    await post('/api/investments', {
      account_id: created.id, code: 'sh518880', name: 'ETF', quantity: 100,
    })
    await del(`/api/accounts/${created.id}`)

    const holdings = JSON.parse((await app.inject({
      method: 'GET', url: '/api/investments', headers: authHeaders(token),
    })).payload).data.items as any[]
    expect(holdings.some((h) => h.account_id === created.id)).toBe(false)
  })

  it('删除后可以还原', async () => {
    const created = JSON.parse((await post('/api/accounts', { name: '误删', type: 'other' })).payload).data
    await del(`/api/accounts/${created.id}`)
    expect((await list()).find((a) => a.id === created.id)?.is_active).toBe(0)

    const r = await post(`/api/accounts/${created.id}/restore`, {})
    expect(JSON.parse(r.payload).code).toBe(0)
    expect((await list()).find((a) => a.id === created.id)?.is_active).toBe(1)
  })

  it('不能删别人的账户', async () => {
    const other = await createUser(app, 'acctcrud_other')
    const mine = JSON.parse((await post('/api/accounts', { name: '我的', type: 'other' })).payload).data
    const r = await app.inject({
      method: 'DELETE', url: `/api/accounts/${mine.id}`,
      headers: { authorization: `Bearer ${other}` },
    })
    expect(r.statusCode).toBe(404)
    expect((await list()).find((a) => a.id === mine.id)?.is_active).toBe(1)
  })
})
