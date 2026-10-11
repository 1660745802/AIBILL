/**
 * 净资产口径一致性集成测试
 *
 * ## 这个文件在守什么
 *
 * 净资产曾经在服务端有**两套算法**：
 *   `/api/assets/overview` 与 `/api/stats/dashboard` 走 `SUM(accounts.balance)`（现金口径），
 *   而 `/api/assets/portfolio` 是「现金 + 持仓市值」（总价值口径）。
 * 同一份数据下，总览页显示 ¥800、资产页显示 ¥1300，还违反会计恒等式。
 *
 * D1 之后净资产**只有一个真源**：`lib/portfolio.ts` 的读模型。
 * 本文件因此从「两套口径对不齐」的回归，升级成「两个接口必须给出同一个数」的护栏——
 * 哪天有人在 dashboard 里再手写一遍 `SUM(balance)`，下面第一条立刻红。
 *
 * `overview` 的净资产字段（`total_assets` / `total_liabilities` / `net_worth` / `by_type`）
 * 已删除（零消费者）。最后一条用例把**删除本身**也锁住，防止第二套算法复活。
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

  it('dashboard 与 portfolio 给出完全相同的净资产', async () => {
    const dash = await get('/api/stats/dashboard')
    const portfolio = await get('/api/assets/portfolio')

    expect(dash.net_worth.total).toBe(portfolio.netWorth)
  })

  it('下界标记（netWorthComplete / unpricedAccounts）两处也必须一致', async () => {
    // D1-D：dashboard 现在也带这两个字段，否则「portfolio 还没到」的那几十毫秒里
    // 兜底会把一个下界显示成精确值。
    const dash = await get('/api/stats/dashboard')
    const portfolio = await get('/api/assets/portfolio')

    expect(dash.net_worth.netWorthComplete).toBe(portfolio.netWorthComplete)
    expect(dash.net_worth.unpricedAccounts).toBe(portfolio.unpricedAccounts)
  })

  it('所有负余额账户都应计入负债（不只信用卡/贷款）', async () => {
    const portfolio = await get('/api/assets/portfolio')

    // 微信 -30000（透支）+ 银行卡 -12000（12000 支出超出初始余额）+ 信用卡 -80000
    // 活期透支同样是负债，不能因为 asset_type=liquid 就算资产
    expect(portfolio.liability.total).toBe(-122000)
    expect(portfolio.liability.accountCount).toBe(3)
  })

  it('溢缴款账户（正余额）应计入资产，且不抵扣其他卡的欠款', async () => {
    const portfolio = await get('/api/assets/portfolio')

    // 早期 dashboard 按 asset_type 分组后取绝对值，会让 10000 溢缴款抵消部分欠款
    // → 显示欠 112000 而不是 122000
    expect(portfolio.liability.total).toBe(-122000)
    // 唯一的正资产就是那笔溢缴款
    expect(portfolio.assetComposition.total).toBe(10000)
    // 净资产 = 正资产 − 负债
    expect(portfolio.netWorth).toBe(-112000)
  })

  it('overview 不再提供任何净资产口径的字段（第二套算法不许复活）', async () => {
    const overview = await get('/api/assets/overview')

    for (const gone of ['total_assets', 'total_liabilities', 'net_worth', 'by_type', 'asset_breakdown']) {
      expect(gone in overview, `${gone} 不该再出现`).toBe(false)
    }
    // 它仍然提供账户元数据 + 每账户现金余额（Assets 页在用）
    expect(Array.isArray(overview.accounts)).toBe(true)
    expect(overview.accounts.length).toBeGreaterThan(0)
    expect(overview.accounts[0]).toHaveProperty('balance')
  })

  it('dashboard 不再提供 asset_breakdown（构成请读 portfolio.assetComposition）', async () => {
    const dash = await get('/api/stats/dashboard')
    expect('asset_breakdown' in dash).toBe(false)
  })
})
