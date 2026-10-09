/**
 * 净资产口径一致性集成测试
 *
 * 回归：`/api/stats/dashboard` 与 `/api/assets/overview` 曾对「总负债」用两套口径，
 * 同一份数据下总览页显示 ¥800、资产页显示 ¥1300，且 dashboard 的口径违反了
 * 「总资产 − 总负债 = 净资产」的会计恒等式。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'

describe('净资产口径一致性', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'networth')

    // 微信 1000 元、招行卡 5000 元（转入后 +500）、信用卡 initial_balance -800 元
    const accs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    const wechat = accs.find((a: any) => a.name === '微信')
    const bank = accs.find((a: any) => a.name === '银行卡')

    await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: authHeaders(token),
      payload: { name: '信用卡', type: 'credit', initial_balance: -80000 },
    })
    const created = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: authHeaders(token),
          payload: { name: '溢缴款账户', type: 'other', initial_balance: 10000 },
        })
      ).payload,
    ).data

    // 活期透支：把微信账户的 initial_balance 调成负数
    await app.inject({
      method: 'PUT',
      url: `/api/accounts/${wechat.id}`,
      headers: authHeaders(token),
      payload: { current_balance: -30000 },
    })

    // 给信用卡设置 asset_type = credit（溢缴款账户保持默认 liquid）
    const accs2 = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    const credit = accs2.find((a: any) => a.name === '信用卡')
    await app.inject({
      method: 'PUT',
      url: `/api/assets/accounts/${credit.id}`,
      headers: authHeaders(token),
      payload: { asset_type: 'credit', credit_limit: 500000 },
    })

    // 制造一笔支出，让银行卡余额变化
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(token),
      payload: { items: [{ type: 'expense', amount: 12000, date: '2026-10-01', description: '测试', account_id: bank.id }] },
    })
    expect(created.id).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  async function get(url: string) {
    const res = await app.inject({ method: 'GET', url, headers: authHeaders(token) })
    return JSON.parse(res.payload).data
  }

  it('两个接口的净资产/总负债应完全一致', async () => {
    const dash = await get('/api/stats/dashboard')
    const overview = await get('/api/assets/overview')

    expect(dash.net_worth.total).toBe(overview.net_worth)
    expect(dash.total_liabilities).toBe(overview.total_liabilities)
    expect(dash.total_assets).toBe(overview.total_assets)
  })

  it('会计恒等式成立：总资产 − 总负债 = 净资产', async () => {
    const dash = await get('/api/stats/dashboard')
    const overview = await get('/api/assets/overview')

    expect(dash.total_assets - dash.total_liabilities).toBe(dash.net_worth.total)
    expect(overview.total_assets - overview.total_liabilities).toBe(overview.net_worth)
  })

  it('所有负余额账户都应计入负债（不只信用卡/贷款）', async () => {
    const dash = await get('/api/stats/dashboard')
    const overview = await get('/api/assets/overview')

    // 微信 -30000（透支）+ 银行卡 -12000（12000 支出超出初始余额）+ 信用卡 -80000
    expect(dash.total_liabilities).toBe(122000)
    expect(overview.total_liabilities).toBe(122000)
    // 唯一正余额的是溢缴款账户 +10000
    expect(dash.total_assets).toBe(10000)
    expect(dash.net_worth.total).toBe(-112000)
  })

  it('溢缴款账户（正余额）应计入资产，且不抵扣其他卡的欠款', async () => {
    const overview = await get('/api/assets/overview')
    const credit = overview.accounts.find((a: any) => a.name === '信用卡')
    const extra = overview.accounts.find((a: any) => a.name === '溢缴款账户')

    expect(credit.balance).toBe(-80000)
    expect(extra.balance).toBe(10000)
    // 早期 dashboard 按 asset_type 分组后取绝对值，会让 10000 溢缴款抵消部分欠款
    expect(overview.total_liabilities).toBe(122000)
  })

  it('dashboard 的 asset_breakdown 各组之和应等于净资产', async () => {
    const dash = await get('/api/stats/dashboard')
    const sum = dash.asset_breakdown.reduce((s: number, b: any) => s + b.total, 0)
    expect(sum).toBe(dash.net_worth.total)
  })
})
