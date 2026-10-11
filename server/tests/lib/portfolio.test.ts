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

/**
 * `hasReadings` / `assetComposition`
 *
 * 这两个是 017 之后才必须存在的判据。历史事故：
 * 前端拿 `empty`（“从没写过快照行”）当“有没有数据”，于是**零快照但余额已记上**
 * 的用户被回落到另一个口径（Σ accounts.balance，不含持仓市值），
 * 实测净资产 ¥114,170 显示成 ¥28,000。判据与构成都必须留在 module 里。
 */
describe('buildPortfolio · hasReadings 与资产构成', () => {
  it('零快照但余额非 0（017 权威列）→ hasReadings=true，此时 empty 仍为 true', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', balance: 2800000 })],
      [],                       // 从没写过 asset_snapshots 行
      1, TODAY,
      holdingsWith(8617000),
    )
    // 旧字段语义不变：empty 只回答“有没有历史采样”
    expect(p.empty).toBe(true)
    // 新判据回答“有没有余额读数” —— 余额已经记上了
    expect(p.hasReadings).toBe(true)
    // 净资产含持仓市值，不会因为没写快照就变回现金口径
    expect(p.netWorth).toBe(11417000)
    expect(p.assetComposition.state).toBe('ok')
  })

  it('无快照且余额全为 0 → hasReadings=false（“真没记过”）', () => {
    const p = buildPortfolio([acc(1, { balance: 0 }), acc(2, { balance: 0 })], [], 2, TODAY)
    expect(p.hasReadings).toBe(false)
    expect(p.empty).toBe(true)
    expect(p.assetComposition.state).toBe('no_readings')
    expect(p.assetComposition.rows).toEqual([])
  })

  it('写过一次 0 快照也算有读数 → no_readings 不成立，但没正资产可构成', () => {
    const p = buildPortfolio([acc(1, { balance: 0 })], [snap(1, TODAY, 0)], 1, TODAY)
    expect(p.hasReadings).toBe(true)
    expect(p.assetComposition.state).toBe('no_positive_assets')
  })

  it('全是负余额（信用卡欠款）→ no_positive_assets，不得说成 no_readings', () => {
    const p = buildPortfolio(
      [acc(1, { asset_type: 'credit', balance: -80000 }), acc(2, { balance: -240000 })],
      [snap(1, TODAY, -80000), snap(2, TODAY, -240000)],
      2, TODAY,
    )
    expect(p.hasReadings).toBe(true)
    expect(p.netWorth).toBe(-320000)
    expect(p.liability.total).toBe(-320000)
    // 有读数，只是没有正资产 —— 说成“还没有记过余额”是错的
    expect(p.assetComposition.state).toBe('no_positive_assets')
    expect(p.assetComposition.rows).toEqual([])
    expect(p.assetComposition.total).toBe(0)
  })

  it('构成按账户总价值分组（不是现金），percent 以正资产合计为分母', () => {
    const p = buildPortfolio(
      [
        acc(1, { asset_type: 'liquid', balance: 130000 }),
        acc(INV, { asset_type: 'investment', balance: 2800000 }),
        acc(3, { asset_type: 'credit', balance: -49644 }),
      ],
      [], 3, TODAY, holdingsWith(8617000),
    )
    const c = p.assetComposition
    expect(c.state).toBe('ok')
    // 理财账户按 持仓+现金 = 114,170 计；负债不进构成也不进分母
    expect(c.rows.map((r) => [r.type, r.value])).toEqual([
      ['investment', 11417000],
      ['liquid', 130000],
    ])
    expect(c.total).toBe(11547000)
    expect(c.rows.reduce((s, r) => s + r.percent, 0)).toBeCloseTo(100, 6)
    expect(c.rows[0]!.percent).toBeCloseTo((11417000 / 11547000) * 100, 6)
    // total 是“正资产合计”，≠ netWorth（后者把负债也减进去了）
    expect(c.total).not.toBe(p.netWorth)
    expect(p.netWorth).toBe(11497356)   // 114,170 + 130 - 49.644
  })

  it('行情缺失的账户按现金进构成，与净资产的下界口径一致', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', balance: 2800000 }), acc(2, { balance: 500000 })],
      [], 2, TODAY, holdingsWith(null, 1),   // 持仓没取到价
    )
    expect(p.netWorthComplete).toBe(false)
    expect(p.netWorth).toBe(3300000)                       // 下界
    expect(p.assetComposition.rows.map((r) => [r.type, r.value])).toEqual([
      ['investment', 2800000], ['liquid', 500000],
    ])
    expect(p.assetComposition.state).toBe('ok')
  })

  it('0 余额账户不占构成段；asset_type 缺失归 other', () => {
    const p = buildPortfolio(
      [acc(1, { balance: 0 }), acc(2, { asset_type: '', balance: 1000 })],
      [], 2, TODAY,
    )
    expect(p.assetComposition.rows).toEqual([{ type: 'other', value: 1000, percent: 100 }])
  })

  it('旧字段全部保留（本次只新增，响应形状向后兼容）', () => {
    const p = buildPortfolio([acc(1, { balance: 100 })], [snap(1, TODAY, 100)], 1, TODAY)
    for (const k of [
      'netWorth', 'netWorthComplete', 'unpricedAccounts', 'previousNetWorth',
      'change', 'changeRate', 'accounts', 'investment', 'liability', 'curve',
      'empty', 'lastUpdated',
    ]) {
      expect(p).toHaveProperty(k)
    }
  })

  // ── H1：无快照但有持仓市值 → 有读数，state 与 rows 自洽 ──
  it('现金 0 + 无快照 + 持仓能估值 → hasReadings=true、state=ok、rows 有该持仓', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', balance: 0 })],
      [],                        // 从没写过快照行
      1, TODAY,
      holdingsWith(8617000),     // 持仓能估值 = 它自己就是一个读数
    )
    expect(p.empty).toBe(true)   // 采样判据不变
    expect(p.hasReadings).toBe(true)
    expect(p.netWorth).toBe(8617000)
    expect(p.assetComposition.state).toBe('ok')
    expect(p.assetComposition.rows).toEqual([
      { type: 'investment', value: 8617000, percent: 100 },
    ])
  })

  it('现金 0 + 无快照 + 持仓取不到价 → 没读数，且 rows 为空（自洽）', () => {
    const p = buildPortfolio(
      [acc(INV, { asset_type: 'investment', balance: 0 })],
      [], 1, TODAY, holdingsWith(null, 1),
    )
    expect(p.hasReadings).toBe(false)
    expect(p.assetComposition.state).toBe('no_readings')
    expect(p.assetComposition.rows).toEqual([])
    // 取不到价但账上确实挂着持仓：净资产是 0 的**下界**（含未取价账户）
    expect(p.netWorth).toBe(0)
    expect(p.netWorthComplete).toBe(false)
  })

  it('不变式：rows 非空 ⟺ state===\'ok\'（多种组合都成立）', () => {
    const cases: Array<[string, ReturnType<typeof buildPortfolio>]> = [
      ['全 0 无快照', buildPortfolio([acc(1, { balance: 0 })], [], 1, TODAY)],
      ['有快照全 0', buildPortfolio([acc(1, { balance: 0 })], [snap(1, TODAY, 0)], 1, TODAY)],
      ['全负债', buildPortfolio([acc(1, { balance: -800 })], [snap(1, TODAY, -800)], 1, TODAY)],
      ['正负混合', buildPortfolio(
        [acc(1, { balance: 500 }), acc(2, { balance: -300 })], [snap(1, TODAY, 500)], 2, TODAY,
      )],
      ['无快照 + 持仓', buildPortfolio(
        [acc(INV, { asset_type: 'investment', balance: 0 })], [], 1, TODAY, holdingsWith(8617),
      )],
      ['无快照 + 持仓未取价', buildPortfolio(
        [acc(INV, { asset_type: 'investment', balance: 0 })], [], 1, TODAY, holdingsWith(null, 1),
      )],
    ]
    for (const [name, p] of cases) {
      expect(p.assetComposition.rows.length > 0, name).toBe(p.assetComposition.state === 'ok')
      // 分母为 0 时不得出现 NaN/除零
      if (p.assetComposition.rows.length === 0) expect(p.assetComposition.total, name).toBe(0)
    }
  })
})
