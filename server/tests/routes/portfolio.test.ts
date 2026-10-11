/**
 * 资产工作台：手动快照的写入与读模型
 *
 * 关键约束：读模型**不从流水回算**。线上 551/553 笔交易没有 account_id，
 * 回算必然是错的，所以这条路径只认手动填的快照。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('资产工作台 · 手动快照', () => {
  let app: FastifyInstance
  let token: string
  let otherToken: string
  let accs: Array<{ id: number; name: string }>

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'portfolio')
    otherToken = await createUser(app, 'portfolio_other')

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    )
    accs = body.data.items

    // 把其中一个账户标成投资类
    const db = getDb()
    const wechat = accs.find((a) => a.name === '微信')!
    db.prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(wechat.id)
  })

  afterAll(async () => { await teardownApp(app) })

  it('0 快照时 portfolio 返回 empty，UI 可据此显示「去填」', async () => {
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    )
    expect(res.code).toBe(0)
    expect(res.data.empty).toBe(true)
    expect(res.data.netWorth).toBe(0)
  })

  it('只记现金未配持仓：现金计入净资产，但不编浮盈', async () => {
    const wechat = accs.find((a) => a.name === '微信')!
    const bank = accs.find((a) => a.name === '银行卡')!
    const res = JSON.parse(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assets/snapshots',
          headers: authHeaders(token),
          payload: {
            date: '2026-10-10',
            items: [
              { account_id: wechat.id, balance: 100000 },
              { account_id: bank.id, balance: 250000 },
            ],
          },
        })
      ).payload,
    )
    expect(res.code).toBe(0)
    expect(res.data.saved).toBe(2)
    // 总投入是账户属性，单独设（只在存/取钱时改）
    await app.inject({
      method: 'PUT', url: `/api/assets/accounts/${wechat.id}`,
      headers: authHeaders(token), payload: { invested_total: 72000 },
    })
    const p = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    ).data

    expect(p.empty).toBe(false)
    expect(p.netWorth).toBe(350000)          // 现金仍计入净资产
    expect(p.investment.cash).toBe(100000)   // 现金是现金
    // 还没配持仓 → 不能凭 quantity + total_invested 出市值（没有价格来源）
    expect(p.investment.marketValue).toBe(0)
    expect(p.investment.unrealized).toBeNull()  // 不是亏损，是未配置
    const wa = p.accounts.find((a: any) => a.accountId === wechat.id)
    expect(wa.holdingsPending).toBe(true)   // 有总投入但没配持仓 → 未配置，不是亏损
  })

  it('同一天重复提交是覆盖而不是报错（手动录入很常见地会重填）', async () => {
    const wechat = accs.find((a) => a.name === '微信')!
    const res = JSON.parse(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assets/snapshots',
          headers: authHeaders(token),
          payload: { date: '2026-10-10', items: [{ account_id: wechat.id, balance: 999 }] },
        })
      ).payload,
    )
    expect(res.code).toBe(0)
    // 覆盖式写入：同一天再提交就是改现金余额
    const a = res.data.portfolio.accounts.find((x: any) => x.accountId === wechat.id)
    expect(a.cash).toBe(999)
    // 总投入是账户属性，不受快照重写影响
    expect(a.totalInvested).toBe(72000)
  })

  it('拒绝给别人的账户写快照', async () => {
    const foreign = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(otherToken) })).payload,
    ).data.items[0]
    const res = await app.inject({
      method: 'PUT',
      url: '/api/assets/snapshots',
      headers: authHeaders(token),
      payload: { items: [{ account_id: foreign.id, balance: 1 }] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2001)
  })

  it('允许补录历史日期（快照是采样不是流水，漏了能补）', async () => {
    const bank = accs.find((a) => a.name === '银行卡')!
    const res = JSON.parse(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assets/snapshots',
          headers: authHeaders(token),
          payload: { date: '2026-10-01', items: [{ account_id: bank.id, balance: 240000 }] },
        })
      ).payload,
    )
    expect(res.code).toBe(0)
    expect(res.data.date).toBe('2026-10-01')
    const curve = res.data.portfolio.curve
    expect(curve[0].date).toBe('2026-10-01')
  })

  it('快照按用户隔离：A 看不到 B 的', async () => {
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(otherToken) })).payload,
    )
    expect(res.data.empty).toBe(true)
    expect(res.data.netWorth).toBe(0)
  })

  it('负余额是合法的（信用卡欠款 = 负债），且被单列出来', async () => {
    const bank = accs.find((a) => a.name === '银行卡')!
    const res = JSON.parse(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assets/snapshots',
          headers: authHeaders(token),
          payload: { date: '2026-10-11', items: [{ account_id: bank.id, balance: -49644 }] },
        })
      ).payload,
    )
    expect(res.code).toBe(0)
    const p = res.data.portfolio
    expect(p.liability.total).toBe(-49644)
    expect(p.liability.accountCount).toBe(1)
    // 净资产已经把负债减进去了
    expect(p.netWorth).toBe(999 - 49644)
  })
})

/**
 * 持仓口径：挂了持仓的账户，账户总价值 = 持仓市值 + 现金余额。
 * §3 的 bug：旧实现把 asset_snapshots.balance 当账户总价值，持仓市值凭空消失。
 * 这里走完整链路：investments + investment_quotes → GET /api/assets/portfolio。
 */
describe('资产工作台 · 持仓口径（市值 + 现金）', () => {
  let app: FastifyInstance
  let token: string
  let secAccId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'portfolio_holdings')

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    )
    const accounts = body.data.items as Array<{ id: number; name: string }>

    const db = getDb()
    // 把「银行卡」改成证券账户，并挂一只黄金 ETF 持仓
    const sec = accounts.find((a) => a.name === '银行卡')!
    secAccId = sec.id
    db.prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(secAccId)
    const uid = (db.prepare('SELECT user_id FROM accounts WHERE id=?').get(secAccId) as { user_id: number }).user_id

    // §3 验算：10,000 份 @ 8.617 = ¥86,170（市值）。
    // 单只**不记成本**（用户要求），总投入是账户级的，下面快照里给。
    // 快照（现金 ¥28,000 / 总投入 ¥100,000）由各用例自己写。
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 10000)`,
    ).run(uid, secAccId)
    // 行情：单价 8.617 元
    db.prepare(
      `INSERT INTO investment_quotes (code, name, price, prev_close, change_rate, quote_date, quoted_at)
       VALUES ('sh518880', '黄金ETF', 8.617, 8.60, 0.002, '2026-10-10', '2026-10-10 15:00:00')`,
    ).run()
  })

  afterAll(async () => { await teardownApp(app) })

  it('证券账户净资产 = 持仓市值 + 现金，持仓市值不再凭空消失', async () => {
    // 现金 ¥28,000；账户级净投入 ¥100,000
    await app.inject({
      method: 'PUT',
      url: '/api/assets/snapshots',
      headers: authHeaders(token),
      payload: {
        date: '2026-10-10',
        items: [{ account_id: secAccId, balance: 2800000 }],
      },
    })
    await app.inject({
      method: 'PUT', url: `/api/assets/accounts/${secAccId}`,
      headers: authHeaders(token), payload: { invested_total: 10000000 },
    })
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    )
    const p = res.data
    const a = p.accounts.find((x: any) => x.accountId === secAccId)
    expect(a.hasHoldings).toBe(true)
    expect(a.cash).toBe(2800000)          // 现金
    expect(a.holdingsValue).toBe(8617000) // 10,000 × 8.617 元 = ¥86,170
    expect(a.value).toBe(11417000)        // 总价值 ¥114,170
    expect(a.unrealized).toBe(1417000)    // +¥14,170 = 114,170 - 100,000
    // 净资产含完整持仓市值
    expect(p.netWorth).toBe(11417000)
    expect(p.netWorthComplete).toBe(true)
    // 曲线拆两条
    const last = p.curve[p.curve.length - 1]
    expect(last.holdingsSum).toBe(8617000)
    expect(last.cashSum).toBe(2800000)
  })

  it('行情缺失时账户总价值 = null，不进净资产', async () => {
    const db = getDb()
    // 清掉行情，模拟抓不到价
    db.prepare("DELETE FROM investment_quotes WHERE code='sh518880'").run()
    await app.inject({
      method: 'PUT', url: `/api/assets/accounts/${secAccId}`,
      headers: authHeaders(token), payload: { invested_total: 10000000 },
    })
    const res = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    )
    const p = res.data
    const a = p.accounts.find((x: any) => x.accountId === secAccId)
    expect(a.holdingsValue).toBeNull()
    expect(a.value).toBeNull()
    expect(p.netWorthComplete).toBe(false)
    expect(p.unpricedAccounts).toBe(1)
    // 恢复行情，避免影响其他断言
    db.prepare(
      `INSERT INTO investment_quotes (code, name, price, prev_close, change_rate, quote_date, quoted_at)
       VALUES ('sh518880', '黄金ETF', 8.617, 8.60, 0.002, '2026-10-10', '2026-10-10 15:00:00')`,
    ).run()
  })
})

/**
 * 零快照 + 有持仓：**曾经在这里被前端漏算整笔持仓市值**。
 *
 * 017 之后余额真源是 `accounts.balance`，新增账单实时改它却不写快照行。
 * 前端曾拿 `empty`（从没写过快照行）当“有没有数据”，于是这类用户回落到
 * `/api/stats/dashboard` 的 Σbalance（现金口径），净资产 ¥114,170 显示成 ¥28,000。
 *
 * 现在判据与构成都在 portfolio 里，本测试锁住响应侧的事实。
 */
describe('资产工作台 · 零快照但余额已记上（017 判据）', () => {
  let app: FastifyInstance
  let token: string
  let secAccId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'portfolio_nosnapshot')
    const accounts = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items as Array<{ id: number; name: string }>
    const db = getDb()
    const sec = accounts.find((a) => a.name === '银行卡')!
    secAccId = sec.id
    db.prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(secAccId)
    const uid = (db.prepare('SELECT user_id FROM accounts WHERE id=?').get(secAccId) as { user_id: number }).user_id
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 10000)`,
    ).run(uid, secAccId)
    db.prepare(
      `INSERT INTO investment_quotes (code, name, price, prev_close, change_rate, quote_date, quoted_at)
       VALUES ('sh518880', '黄金ETF', 8.617, 8.60, 0.002, '2026-10-10', '2026-10-10 15:00:00')`,
    ).run()
    // 余额写在权威列上（模拟 017 回填 / 新建账户 / 账单增量），**一行快照都不写**
    db.prepare('UPDATE accounts SET balance = 2800000, invested_total = 10000000 WHERE id=?').run(secAccId)
  })

  afterAll(async () => { await teardownApp(app) })

  it('hasReadings=true、empty 仍为 true，且净资产含持仓市值', async () => {
    const p = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    ).data
    expect(p.empty).toBe(true)                    // 旧字段语义不变：没写过快照行
    expect(p.hasReadings).toBe(true)              // 但余额确实已经记上了
    expect(p.netWorth).toBe(11417000)             // 现金 28,000 + 市值 86,170
    expect(p.netWorthComplete).toBe(true)
    expect(p.assetComposition.state).toBe('ok')
  })

  it('dashboard 仍是现金口径（本次不改 overview/dashboard）—— 差额恰为持仓市值', async () => {
    const dash = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/stats/dashboard', headers: authHeaders(token) })).payload,
    ).data
    const ov = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/overview', headers: authHeaders(token) })).payload,
    ).data
    // 两个 adapter 仍是 Σ accounts.balance（不含持仓市值）—— 已发布契约，本次不动
    expect(dash.net_worth.total).toBe(2800000)
    expect(ov.net_worth).toBe(2800000)
    // 差额 = 持仓市值；前端必须以 portfolio 为准，否则就是漏算
    expect(11417000 - dash.net_worth.total).toBe(8617000)
  })

  /**
   * 把现金改成 0（仍不写任何快照行）：**依然有读数**。
   *
   * 只挂着一只持仓时，市值本身就是一个读数。若此时报 `no_readings`，
   * 仪表会说「还没有记过余额」——而 rows 里同时有一段 ¥86,170 的构成条，
   * state 与 rows 自相矛盾。
   */
  it('现金 0 + 零快照 + 持仓能估值 → hasReadings=true、state=ok、rows 含市值', async () => {
    getDb().prepare('UPDATE accounts SET balance = 0 WHERE id=?').run(secAccId)
    const p = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    ).data
    expect(p.empty).toBe(true)
    expect(p.hasReadings).toBe(true)
    expect(p.netWorth).toBe(8617000)
    expect(p.assetComposition.state).toBe('ok')
    expect(p.assetComposition.rows).toEqual([{ type: 'investment', value: 8617000, percent: 100 }])
  })

  it('行情消失（有持仓但算不出市值）→ 没读数，no_readings 且 rows 为空（自洽）', async () => {
    getDb().prepare("DELETE FROM investment_quotes WHERE code='sh518880'").run()
    const p = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    ).data
    expect(p.hasReadings).toBe(false)
    expect(p.assetComposition.state).toBe('no_readings')
    expect(p.assetComposition.rows).toEqual([])
    expect(p.netWorthComplete).toBe(false)
  })
})

/**
 * 纯负债用户：仪表不得说“还没有记过余额”。
 * 构成空态是 module 的判定（见 AssetCompositionState），这里从HTTP 侧锁住。
 */
describe('资产工作台 · 纯负债账户的空态', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'portfolio_creditonly')
    const accounts = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items as Array<{ id: number; name: string }>
    const db = getDb()
    const credit = accounts.find((a) => a.name === '微信')!
    db.prepare("UPDATE accounts SET asset_type='credit', balance = -80000 WHERE id=?").run(credit.id)
    db.prepare('UPDATE accounts SET balance = 0 WHERE id != ?').run(credit.id)
  })

  afterAll(async () => { await teardownApp(app) })

  it('state=no_positive_assets（有读数、全是负债），rows 为空', async () => {
    const p = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token) })).payload,
    ).data
    expect(p.netWorth).toBe(-80000)
    expect(p.liability).toEqual({ total: -80000, accountCount: 1 })
    expect(p.hasReadings).toBe(true)
    expect(p.assetComposition.state).toBe('no_positive_assets')   // 不是 no_readings
    expect(p.assetComposition.rows).toEqual([])
  })
})
