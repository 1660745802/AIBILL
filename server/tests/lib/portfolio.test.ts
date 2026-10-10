/**
 * 资产工作台读模型的单元测试
 *
 * 口径（用户原话）：
 *   「账户总价值 = 股数×单价 + 余额」「总价值和净投入就能算出亏损和收益」
 *   「投入不要针对单只持仓股，计算总投入就可以」
 *   「想填就填，不想填就是 0」
 *
 * 两个数据源，职责不同（这是签名里显式分开的原因）：
 *   账户（AccountRow）   —— 行源，每个活跃账户一行，不管有没有填过
 *   快照（SnapshotPoint）—— 曲线源，每账户每天一条
 * 混成一份会让「取每账户最新一条」把曲线压成一个点（曾经真的这么错过）。
 *
 * 数据依据：线上 553 笔交易只有 1 笔带 account_id → 绝不能从流水回算资产。
 */
import { describe, it, expect } from 'vitest'
import { buildPortfolio, type AccountRow, type SnapshotPoint } from '../../src/lib/portfolio.js'

const TODAY = '2026-10-10'
const INV = 2

const acc = (id: number, o: Partial<AccountRow> = {}): AccountRow => ({
  account_id: id,
  account_name: `acc${id}`,
  asset_type: 'liquid',
  invested_total: null,
  ...o,
})

const snap = (id: number, date: string, balance: number): SnapshotPoint => ({
  account_id: id, snapshot_date: date, balance,
})

const holdingsWith = (marketValue: number | null, unpricedCount = 0) =>
  new Map([[INV, { marketValue, unpricedCount }]])

describe('buildPortfolio', () => {
  it('没填过任何余额时 empty=true，界面据此显示「去填」而不是一堆 0', () => {
    const p = buildPortfolio([acc(1)], [], 1, TODAY)
    expect(p.empty).toBe(true)
    expect(p.netWorth).toBe(0)
  })

  it('没填过的账户按 0 算，仍然出现在列表里（行源是账户不是快照）', () => {
    const p = buildPortfolio([acc(1), acc(2)], [], 2, TODAY)
    expect(p.accounts).toHaveLength(2)
    expect(p.netWorth).toBe(0)
    expect(p.accounts[0]!.lastUpdated).toBeNull()
    expect(p.accounts[0]!.staleDays).toBeNull()   // 没填过就别说「N 天没更新」
  })

  it('净资产 = 各账户最新一条快照之和', () => {
    const p = buildPortfolio(
      [acc(1), acc(2, { asset_type: 'investment' })],
      [snap(1, '2026-10-09', 100000), snap(2, TODAY, 72550000)],
      2, TODAY,
    )
    expect(p.netWorth).toBe(72650000)
    expect(p.lastUpdated).toBe(TODAY)
  })

  it('同账户多天快照只取最新一条计入净资产', () => {
    const p = buildPortfolio([acc(1)], [
      snap(1, '2026-10-08', 100), snap(1, '2026-10-09', 200), snap(1, TODAY, 300),
    ], 1, TODAY)
    expect(p.netWorth).toBe(300)
  })

  it('曲线保留全部历史点（补录一天会多一个点）', () => {
    const p = buildPortfolio([acc(1)], [
      snap(1, '2026-10-01', 240000), snap(1, TODAY, 250000),
    ], 1, TODAY)
    expect(p.curve.map((c) => c.date)).toEqual(['2026-10-01', '2026-10-10'])
    expect(p.curve[0]!.cashSum).toBe(240000)
  })

  it('挂了持仓：总价值 = 持仓市值 + 现金，浮盈 = 总价值 − 总投入', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', invested_total: 10000000 })],
      [snap(INV, TODAY, 2800000)],                       // 现金 ¥28,000
      1, TODAY, holdingsWith(8617000),                   // 持仓市值 ¥86,170
    )
    const a = p.accounts[0]!
    expect(a.hasHoldings).toBe(true)
    expect(a.cash).toBe(2800000)
    expect(a.holdingsValue).toBe(8617000)
    expect(a.value).toBe(11417000)                     // 86,170 + 28,000
    expect(a.unrealized).toBe(1417000)                 // 114,170 − 100,000
    expect(p.netWorth).toBe(11417000)                  // 持仓市值不再凭空消失

    // 聚合与账户级同口径（现金算进去），否则同屏两个数打架
    expect(p.investment.marketValue).toBe(8617000)     // 纯持仓
    expect(p.investment.cash).toBe(2800000)
    expect(p.investment.unrealized).toBe(1417000)
  })

  it('没配持仓 + 有总投入：浮盈给 null，绝不能显示成亏损', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', invested_total: 7200000 })],
      [snap(INV, TODAY, 8617000)],
      1, TODAY,
    )
    const a = p.accounts[0]!
    expect(a.holdingsPending).toBe(true)               // UI 据此说「持仓未配置」
    expect(a.unrealized).toBeNull()
    expect(a.value).toBe(8617000)                      // 无持仓时总价值 = 现金
    expect(p.investment.unrealized).toBeNull()
  })

  it('没填过现金的理财账户：现金按 0，但对上总投入仍算「未配置」而不是亏损', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', invested_total: 10000000 })],
      [],                                              // 从没填过余额
      1, TODAY, holdingsWith(8617000),
    )
    const a = p.accounts[0]!
    expect(a.cash).toBe(0)
    expect(a.value).toBe(8617000)                      // 持仓市值 + 0
    // 有持仓 → 不是 pending，但总投入 100,000 vs 总价值 86,170 → 这是真亏
    expect(a.holdingsPending).toBe(false)
    expect(a.unrealized).toBe(-1383000)
  })

  it('行情缺失：账户总价值 = null（不冒充），但现金仍计入净资产并标记下界', () => {
    const p = buildPortfolio([acc(INV, { asset_type: 'investment' })], [snap(INV, TODAY, 2800000)], 1, TODAY, holdingsWith(null, 1))
    const a = p.accounts[0]!
    expect(a.value).toBeNull()
    expect(p.netWorth).toBe(2800000)                   // 现金是已知的，不能丢
    expect(p.netWorthComplete).toBe(false)             // UI 据此显示「≥¥X」
    expect(p.unpricedAccounts).toBe(1)
    expect(p.investment.marketValue).toBeNull()        // 聚合也不拿部分之和冒充
  })

  it('没有总投入时不算浮盈，也不编 0', () => {
    const p = buildPortfolio([acc(INV, { asset_type: 'investment' })], [snap(INV, TODAY, 500000)], 1, TODAY, holdingsWith(8617000))
    expect(p.accounts[0]!.unrealized).toBeNull()
  })

  it('负债账户浮盈为 null，并单列负债', () => {
    const p = buildPortfolio(
      [acc(9, { asset_type: 'credit', invested_total: 100000 })],
      [snap(9, TODAY, -49644)],
      1, TODAY,
    )
    expect(p.accounts[0]!.isDebt).toBe(true)
    expect(p.accounts[0]!.unrealized).toBeNull()
    expect(p.liability.total).toBe(-49644)
    expect(p.liability.accountCount).toBe(1)
  })

  it('没持仓的账户，现金不得被当成持仓市值', () => {
    const p = buildPortfolio([acc(INV, { asset_type: 'investment', invested_total: 0 })], [snap(INV, TODAY, 500000)], 1, TODAY)
    expect(p.investment.marketValue).toBe(0)
    expect(p.investment.cash).toBe(500000)
  })

  it('曲线拆成「持仓市值」和「现金」两条', () => {
    const p = buildPortfolio([acc(INV, { asset_type: 'investment' })], [snap(INV, TODAY, 2800000)], 1, TODAY, holdingsWith(8617000))
    const last = p.curve[p.curve.length - 1]!
    expect(last.holdingsSum).toBe(8617000)
    expect(last.cashSum).toBe(2800000)
    expect(last.updatedSum).toBe(11417000)
  })

  it('曲线带每日覆盖率——只更新了部分账户那天要看得出来', () => {
    const p = buildPortfolio([acc(1), acc(2)], [
      snap(1, '2026-10-09', 100), snap(2, '2026-10-09', 200), snap(1, TODAY, 150),
    ], 2, TODAY)
    const last = p.curve[p.curve.length - 1]!
    expect(last.accountCount).toBe(1)
    expect(last.expectedAccounts).toBe(2)
  })

  it('日变动只在「全员都覆盖过」的上一次才给，否则 null', () => {
    const p = buildPortfolio([acc(1), acc(2)], [
      snap(1, '2026-10-09', 100), snap(2, '2026-10-09', 200), snap(1, TODAY, 120),
    ], 2, TODAY)
    expect(p.netWorth).toBe(320)
    expect(p.previousNetWorth).toBe(300)
    expect(p.change).toBe(20)

    const q = buildPortfolio([acc(1), acc(2)], [snap(1, TODAY, 100), snap(2, TODAY, 200)], 2, TODAY)
    expect(q.previousNetWorth).toBeNull()
  })

  it('staleDays 提示「该更新了」；没填过则为 null', () => {
    const p = buildPortfolio([acc(1), acc(2, { account_name: 'never' })], [snap(1, '2026-10-01', 100)], 2, TODAY)
    expect(p.accounts.find((a) => a.accountId === 1)!.staleDays).toBe(9)
    expect(p.accounts.find((a) => a.accountId === 2)!.staleDays).toBeNull()
  })
})
