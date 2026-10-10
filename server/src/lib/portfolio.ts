/**
 * 证券/资产工作台的读模型
 *
 * 全部基于 `asset_snapshots`（手动填写的采样），**不从流水回算**。
 * 原因：`transactions.account_id` 有 551/553 为 NULL，回算余额必然是错的。
 * 既然回算不可靠，就直接记「某天这个账户值多少」。
 *
 * 四个必须说清的口径：
 *
 * 1. **净资产 = 各账户最新一条快照之和**，不是「同一天的快照之和」。
 *    账户更新时间天然不同步（今天可能只看了证券），强行按日期对齐会算错。
 *
 * 2. **挂了持仓的账户，总价值 = 持仓市值 + 现金余额**。
 *    对这类账户，`asset_snapshots.balance` 存的是**现金余额**，不是账户总价值。
 *    持仓市值 = Σ(股数 × 单价)，由 `investments × investment_quotes` 实时算出
 *    （见 `holdings.ts`），通过 `holdingsByAccount` 传进来。
 *    无持仓的账户仍然用 `balance` 当总价值（历史语义不变）。
 *
 * 3. **净值曲线上每天的覆盖率要一起返回**。某天只更新了 2/5 个账户时，
 *    那天曲线上的点其实是「2 个新 + 3 个旧」，不说清楚就是骗人。
 *    曲线同时拆成「持仓市值」和「现金」两条——分开看才知道该不该加仓
 *    （持仓涨 + 现金降 = 在追高）。
 *
 * 4. **行情缺失时市值 = null，不给 0**。0 会被读成「持仓归零了」，是错误信息；
 *    null 才是「暂时不知道它值多少」。某账户持仓无法估值时，它的总价值也是 null，
 *    该账户**只把现金计入净资产**（持仓那块未知），并通过
 *    `netWorthComplete=false` + `unpricedAccounts` 告知 UI 这是个下界，要显示「≥¥X」。
 */

/**
 * 行源：**每个活跃账户一行**（不管有没有填过余额）。
 * 用户的口径是「想填就填，不想填就是 0」，所以没填过的账户也必须在这里，
 * 否则它既进不了净资产、页面上也没处填。
 */
export interface AccountRow {
  account_id: number
  account_name: string
  asset_type: string
  /** 账户级总投入（分），来自 `accounts.invested_total` */
  invested_total: number | null
}

/**
 * 曲线源：快照**历史**（每个账户每天一条）。
 * 行源只给"现在"，历史必须单独来——两者是不同的问题，
 * 混成一份会让「取最新一条」把曲线压成一个点（曾经真的这么错过）。
 */
export interface SnapshotPoint {
  account_id: number
  snapshot_date: string
  balance: number
}

/**
 * 某账户按标的汇总后的持仓估值，由 `holdings.ts` 的 `valuePortfolio` 产出。
 * 传进来表示「这个账户挂了持仓」——它的 balance 要当现金处理。
 */
export interface AccountHoldings {
  /** 持仓市值合计（分）。只要有任一标的取不到行情就为 null（不拿部分之和冒充） */
  marketValue: number | null
  /** 取不到行情的标的数——UI 要说「有 N 个没取到价」而不是假装完整 */
  unpricedCount: number
}

export interface AccountPosition {
  accountId: number
  name: string
  assetType: string
  isInvestment: boolean
  /** 该账户挂了持仓（balance 当现金处理） */
  hasHoldings: boolean
  /** 负余额 = 负债（信用卡欠款） */
  isDebt: boolean
  /** 有净投入但还没配持仓 —— 不显示盈亏，显示「持仓未配置」 */
  holdingsPending: boolean
  /**
   * 现金余额（分）。
   * - 挂了持仓的账户：= snapshot.balance
   * - 无持仓的账户：= snapshot.balance（此时现金就是账户全部）
   */
  cash: number
  /** 持仓市值（分）。无持仓账户为 0；挂了持仓但行情缺失为 null */
  holdingsValue: number | null
  /**
   * 账户总价值（分）= 持仓市值 + 现金。
   * 挂了持仓但行情缺失（holdingsValue=null）时为 null——不编一个数出来。
   * 无持仓账户 = cash。
   */
  value: number | null
  /** @deprecated 旧字段名。等同 `cash`，为兼容未迁移的调用方保留 */
  balance: number
  /** 账户级总投入（分），来自 accounts.invested_total */
  totalInvested: number | null
  /** 最新一条快照的日期；null = 从没填过 */
  lastUpdated: string | null
  /** 距今天数；null = 从没填过（不显示「N 天没更新」） */
  staleDays: number | null
  /**
   * 浮动盈亏 = 账户总价值 − 总投入（分）。
   * 三个条件缺一不可，否则给 null（不编数）：有现金读数、有持仓市值、有总投入。
   * 注意：本函数只遍历**有快照的**账户，所以「有现金读数」恒成立；
   * 「连快照都没有」的账户由前端的行源（/accounts）负责显示「未记」。
   */
  unrealized: number | null
  /** 浮动收益率 = 浮盈 / 净投入 */
  unrealizedRate: number | null
}

export interface NetWorthPoint {
  date: string
  /** 当天有更新的账户总价值之和（持仓市值 + 现金） */
  updatedSum: number
  /** 当天持仓市值之和（拆条用） */
  holdingsSum: number
  /** 当天现金之和（拆条用） */
  cashSum: number
  /** 当天更新的账户数 */
  accountCount: number
  /** 当天应有的账户数（该用户 is_active 的账户总数） */
  expectedAccounts: number
}

/** 负债合计（负余额账户）。信用卡欠款是负数，这是合法状态不是错误 */
export interface Liability {
  total: number
  accountCount: number
}

export interface Portfolio {
  /** 各账户最新快照的总价值求和（持仓市值 + 现金），行情缺失的账户不计入 */
  netWorth: number
  /** 净资产是否完整：有账户因行情缺失无法估值时为 false */
  netWorthComplete: boolean
  /** 因行情缺失无法估值的账户数 */
  unpricedAccounts: number
  /** 昨天/上一次更新之和，用于算日变动 */
  previousNetWorth: number | null
  change: number | null
  changeRate: number | null
  accounts: AccountPosition[]
  /** 投资类账户合计 */
  investment: {
    /** 只含持仓，不含现金。任一持仓未取到价时为 null（不拿部分之和冒充） */
    marketValue: number | null
    /** 投资账户里的现金 */
    cash: number
    totalInvested: number
    /** 浮盈 = 持仓市值 + 现金 - 净投入。任一投资账户「持仓未配置」时为 null */
    unrealized: number | null
    unrealizedRate: number | null
    accountCount: number
  }
  /** 负余额账户合计（信用卡等） */
  liability: Liability
  curve: NetWorthPoint[]
  /** 0 行快照时为 true——UI 该显示「去填」而不是空白图表 */
  /**
   * 没有任何账户填过余额 —— 页面据此显示「去填」而不是一堆 0。
   * 注意：账户本身可能都在（行源是账户），所以不能用 rows.length 判断。
   */
  empty: boolean
  lastUpdated: string | null
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()
  return Math.round(ms / 86400000)
}

export function buildPortfolio(
  accountsIn: AccountRow[],
  history: SnapshotPoint[],
  expectedAccounts: number,
  today: string,
  /**
   * 账户持仓估值。key = account_id。
   * 传了（即使 marketValue=null）就表示该账户「挂了持仓」，balance 当现金处理。
   * 省略或空 Map 时退化为旧语义：所有账户都用 balance 当总价值。
   */
  holdingsByAccount: Map<number, AccountHoldings> = new Map(),
): Portfolio {
  // 每个账户的「最新一条快照」从历史里取；没填过 → date=null、balance 按 0
  const latestByAccount = new Map<number, SnapshotPoint>()
  for (const h of history) {
    const cur = latestByAccount.get(h.account_id)
    if (!cur || h.snapshot_date > cur.snapshot_date) latestByAccount.set(h.account_id, h)
  }

  const accounts: AccountPosition[] = []
  for (const r of accountsIn) {
    const accountId = r.account_id
    const snap = latestByAccount.get(accountId)
    const balance = snap?.balance ?? 0
    const isInvestment = r.asset_type === 'investment'
    const isDebt = balance < 0
    const holdings = holdingsByAccount.get(accountId) ?? null
    const hasHoldings = holdings !== null

    // 现金 = 最新快照的余额；从没填过就是 0（用户口径：不想填就是 0）
    const cash = balance

    // 持仓市值：挂了持仓用传进来的市值（行情缺失为 null）；无持仓为 0
    const holdingsValue = hasHoldings ? holdings.marketValue : 0
    // 账户总价值 = 持仓市值 + 现金。挂了持仓但行情缺失 → null（不编数）
    const value = hasHoldings
      ? (holdings.marketValue != null ? holdings.marketValue + cash : null)
      : cash

    // 总投入 = **账户级**，来自 accounts.invested_total（由 readSnapshots join 进来）。
    // 不再从持仓聚合——用户明确「投入不要针对单只持仓股，计算总投入就可以」。
    const totalInvested = r.invested_total

    // 浮盈 = 账户总价值 - 净投入，但**只有配了持仓才算得出**。
    //
    // 关键：没配持仓 + 有净投入时，`cash - totalInvested` 会得出一个大负数
    // （填了 ¥100,000 净投入、只记了 ¥28,000 现金 → 显示亏 ¥72,000）。
    // 那不是亏损，是**没配置**。把「未配置」显示成「亏了」是最坏的错误——
    // 会让用户以为自己赔钱了，而实际上钱只是在券商里没录进来。
    // 所以这种状态一律返回 null，由 UI 说「持仓未配置」而不是编一个负数。
    const holdingsPending = !hasHoldings && !isDebt && (totalInvested ?? 0) > 0
    const unrealizedBase = hasHoldings ? value : null
    const unrealized = !isDebt && totalInvested != null && unrealizedBase != null
      ? unrealizedBase - totalInvested
      : null

    accounts.push({
      accountId,
      name: r.account_name,
      assetType: r.asset_type,
      isInvestment,
      hasHoldings,
      /** 有净投入但还没配持仓：UI 该说「持仓未配置」而不是「亏损」 */
      holdingsPending,
      isDebt,
      cash,
      holdingsValue,
      value,
      balance: cash,
      totalInvested,
      lastUpdated: snap?.snapshot_date ?? null,
      staleDays: snap ? daysBetween(snap.snapshot_date, today) : null,
      unrealized,
      unrealizedRate:
        unrealized != null && totalInvested ? unrealized / totalInvested : null,
    })
  }
  // 排序用账户总价值（行情缺失排最后）
  accounts.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))

  /**
   * 净资产 = 各账户总价值之和。
   *
   * 行情缺失（value=null）的账户**仍然计入它的现金**，因为现金是已知的、
   * 只有持仓那一块不知道。曾经把整账户排除 —— 结果是「账户里明明有 ¥28,000 现金，
   * 净资产里一分都不算」，而且仪表上不提示，用户看到的是一个偏小的确定数。
   *
   * 所以这个和是一个**下界**：还有 N 个账户的持仓没取到价 → 实际 ≥ 这个数。
   * UI 必须据此显示「≥¥X」，不能当成精确值（`netWorthComplete` 就是给它看的）。
   */
  let netWorth = 0
  let unpricedAccounts = 0
  for (const a of accounts) {
    netWorth += a.value ?? a.cash
    if (a.value == null) unpricedAccounts++
  }
  const netWorthComplete = unpricedAccounts === 0

  // 用某日期 D 时每个账户的「截至 D 最新快照 + 当前持仓估值」算总价值
  function valueAt(perAccount: Map<number, SnapshotPoint>): number {
    let sum = 0
    for (const [accId, r] of perAccount) {
      const h = holdingsByAccount.get(accId) ?? null
      if (h) {
        if (h.marketValue != null) sum += h.marketValue + r.balance
        // 行情缺失则该账户不计入（与 netWorth 口径一致）
      } else {
        sum += r.balance
      }
    }
    return sum
  }

  // 上一次「全员账户都覆盖到」的完整读数，用它算日变动。
  // 判定标准：存在一个日期 D（严格早于最新数据），每个账户在 D 或之前都有快照。
  // 找不到就返回 null —— 不能拿“只更新了两个账户”的部分之和冒充全量。
  const dates = [...new Set(history.map((h) => h.snapshot_date))].sort()
  const latestDate = dates[dates.length - 1] ?? ''
  let previousNetWorth: number | null = null
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i]!
    if (d >= latestDate) continue
    const perAccount = new Map<number, SnapshotPoint>()
    for (const h of history) {
      if (h.snapshot_date > d) continue
      const cur = perAccount.get(h.account_id)
      if (!cur || h.snapshot_date > cur.snapshot_date) perAccount.set(h.account_id, h)
    }
    if (expectedAccounts > 0 && perAccount.size === expectedAccounts) {
      previousNetWorth = valueAt(perAccount)
      break
    }
  }

  const change = previousNetWorth != null ? netWorth - previousNetWorth : null

  // 曲线：按日期聚合，附覆盖率，并拆「持仓市值 / 现金」两条。
  // 历史持仓市值用「当前持仓估值」近似（investments 不存份额历史）；
  // 挂了持仓的账户，balance 当现金；无持仓账户 balance 全部计入现金。
  const byDate = new Map<string, { holdings: number; cash: number; count: number }>()
  for (const p of history) {
    const e = byDate.get(p.snapshot_date) ?? { holdings: 0, cash: 0, count: 0 }
    const h = holdingsByAccount.get(p.account_id) ?? null
    if (h && h.marketValue != null) {
      e.holdings += h.marketValue
      e.cash += p.balance
    } else {
      // 无持仓账户，或行情缺失：balance 全部当现金（不编持仓市值）
      e.cash += p.balance
    }
    e.count += 1
    byDate.set(p.snapshot_date, e)
  }
  const curve: NetWorthPoint[] = [...byDate.entries()]
    .map(([date, v]) => ({
      date,
      updatedSum: v.holdings + v.cash,
      holdingsSum: v.holdings,
      cashSum: v.cash,
      accountCount: v.count,
      expectedAccounts,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // 负余额 = 负债。注意净资产已经把它们减进去了，这里只是单列出来给人看。
  // 口径用现金余额判定（持仓市值不会是负的）。
  const debts = accounts.filter((a) => a.cash < 0)
  const liability: Liability = {
    total: debts.reduce((s, a) => s + a.cash, 0),
    accountCount: debts.length,
  }

  // 投资类账户合计。
  //
  // 三个数必须分清，混在一起算出的浮盈是错的（实测：持仓 86,170 + 现金 28,000
  // + 净投入 100,000，旧代码算出 −13,830，而按用户口径应该是 +14,170）：
  //   marketValue  = 持仓市值，**只有持仓**，现金不是它
  //   cash         = 投资账户里还没投出去的钱
  //   unrealized   = 账户总价值（持仓 + 现金） − 净投入
  // 拿了 ¥100,000 放进来，其中 28,000 还是现金 —— 那不是亏损，
  // 只有把现金漏掉才把「没投出的钱」算成了亏损。
  //
  // 旧代码对没持仓的账户用 cash 充当 marketValue，等于把现金标成持仓市值，也不对。
  const inv = accounts.filter((a) => a.isInvestment)
  // 任一账户的持仓没取到价 → 聚合市值给 null，与账户级同规则。
  // 曾经写 `a.holdingsValue ?? 0`：账户行显示「算不出」，聚合却给出一个具体数 ——
  // 同一响应里两个口径打架，正是「同一个量被算了几遍」的典型。
  const anyHoldingsUnpriced = inv.some((a) => a.hasHoldings && a.holdingsValue == null)
  const marketValue = anyHoldingsUnpriced
    ? null
    : inv.reduce((s, a) => s + (a.hasHoldings ? (a.holdingsValue ?? 0) : 0), 0)
  const cash = inv.reduce((s, a) => s + a.cash, 0)
  const totalInvested = inv.reduce((s, a) => s + (a.totalInvested ?? 0), 0)
  // 投资账户里有任何一个「有净投入却没配持仓」时，聚合级浮盈同样是编的 → 给 null
  const pendingAccounts = inv.filter((a) => a.holdingsPending)
  const unrealized = pendingAccounts.length > 0 || marketValue == null
    ? null
    : marketValue + cash - totalInvested

  return {
    netWorth,
    netWorthComplete,
    unpricedAccounts,
    previousNetWorth,
    change,
    changeRate: change != null && previousNetWorth ? change / previousNetWorth : null,
    accounts,
    investment: {
      marketValue,
      cash,
      totalInvested,
      unrealized,
      unrealizedRate: unrealized != null && totalInvested ? unrealized / totalInvested : null,
      accountCount: inv.length,
    },
    liability,
    curve,
    empty: accounts.every((a) => a.lastUpdated == null),
    lastUpdated: accounts[0]?.lastUpdated ?? null,
  }
}
