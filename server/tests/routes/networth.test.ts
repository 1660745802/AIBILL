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
 * ⚠️ **这条护栏能不能红，取决于夹具里有没有持仓。**
 * 审查（F1）指出：若夹具只有现金账户，每个账户 `value === cash`，
 * 于是 `Σcash ≡ SUM(accounts.balance)`，断言两边恒等、改回现金口径也不红。
 * 所以下面的 beforeAll 特意带了一个**市值 ≠ 现金**的持仓账户
 * （现金 0 / 市值 86,170），这是鉴别力的来源，别把它当成冗余夹具删掉。
 *
 * `overview` 的净资产字段（`total_assets` / `total_liabilities` / `net_worth` / `by_type`）
 * 已删除（零消费者）。最后一条用例把**删除本身**也锁住，防止第二套算法复活。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

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

    /**
     * **必留**：市值 ≠ 现金的持仓账户，是本文件断言的鉴别力来源。
     * 现金 0 分，持仓市值 8,617,000 分（10000 份 × 8.617 元 = 86,170 元）。
     * 少了它，`net_worth.total` 与 `Σbalance` 恒等，护栏就退化成恒真断言。
     */
    const db = getDb()
    const invAcc = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: authHeaders(token),
          payload: { name: '证券账户', type: 'other', initial_balance: 0 },
        })
      ).payload,
    ).data as { id: number }
    const uid = (db.prepare('SELECT user_id FROM accounts WHERE id=?').get(invAcc.id) as { user_id: number }).user_id
    db.prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(invAcc.id)
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 10000)`,
    ).run(uid, invAcc.id)
    db.prepare(
      `INSERT INTO investment_quotes (code, name, price, prev_close, change_rate, quote_date, quoted_at)
       VALUES ('sh518880', '黄金ETF', 8.617, 8.60, 0.002, '2026-10-10', '2026-10-10 15:00:00')`,
    ).run()

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

  it('（鉴别力自检）净资产 ≠ Σ现金，否则上面那条是恒真断言', async () => {
    /**
     * 审查 F1：若夹具只有现金账户，`value === cash`，于是
     * `net_worth.total ≡ SUM(accounts.balance)` —— 改回现金口径也不会红。
     * 所以这里**显式断言**两者确实不同，一旦有人把持仓夹具删了，本条先红。
     */
    const dash = await get('/api/stats/dashboard')
    const cashSum = dash.net_worth.accounts.reduce((s: number, a: any) => s + a.cash, 0)

    // 现金合计 -112,000 分；持仓市值 8,617,000 分 → 净资产 8,505,000 分
    expect(cashSum).toBe(-112000)
    expect(dash.net_worth.total).toBe(8505000)
    expect(dash.net_worth.total).not.toBe(cashSum)
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
    // 正资产 = 溢缴款 10,000 + 证券账户持仓市值 8,617,000
    expect(portfolio.assetComposition.total).toBe(8627000)
    // 净资产 = 正资产 − 负债 = 8,627,000 − 122,000
    expect(portfolio.netWorth).toBe(8505000)
  })

  it('overview / dashboard 都不再提供净资产口径的字段（第二套算法不许复活）', async () => {
    const overview = await get('/api/assets/overview')
    const dash = await get('/api/stats/dashboard')

    // 审查 F10：以前只对 overview 断言，dashboard 重新长出 total_assets/
    // total_liabilities 不会有任何用例变红。两边一起锁。
    for (const gone of ['total_assets', 'total_liabilities', 'net_worth', 'by_type']) {
      expect(gone in overview, `overview.${gone} 不该再出现`).toBe(false)
    }
    for (const gone of ['total_assets', 'total_liabilities', 'asset_breakdown']) {
      expect(gone in dash, `dashboard.${gone} 不该再出现`).toBe(false)
    }

    // overview 仍提供账户元数据 + 每账户现金余额（Assets 页在用）
    expect(Array.isArray(overview.accounts)).toBe(true)
    expect(overview.accounts.length).toBeGreaterThan(0)
    expect(overview.accounts[0]).toHaveProperty('balance')
  })
})
