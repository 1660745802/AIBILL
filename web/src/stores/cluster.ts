import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/index'
import type { CompositionState, PortfolioResponse } from '@/api/types'

/**
 * 仪表读数的数据源。
 *
 * 以前 /stats/dashboard 只被 Dashboard.vue 拉一次，所以仪表读数拿不到数据，
 * 每个页面各拉各的（还拉不到彼此的）。现在它是一份共享数据：
 * 仪表读数 = 真读数（不是假图表），任何页面都能就地拿到同一份口径。
 */
export const useClusterStore = defineStore('cluster', () => {
  const data = ref<any>(null)
  const loading = ref(false)
  const error = ref('')
  const updatedAt = ref<number | null>(null)

  async function load(force = false) {
    if (loading.value) return
    // 30 秒内不重复打：仪表读数最怕「刷新一下数字就跳」，抖动比慢更烦
    if (!force && data.value && updatedAt.value && Date.now() - updatedAt.value < 30_000) return
    loading.value = true
    void loadPortfolio()
    try {
      const res = await api.get('/stats/dashboard')
      if (res.data.code === 0) {
        data.value = res.data.data
        updatedAt.value = Date.now()
        error.value = ''
      }
    } catch (e: any) {
      error.value = e.response?.data?.message || '读数拉取失败'
    } finally {
      loading.value = false
    }
  }

  /* ── 读数 1：净资产 ──
     **只读 portfolio**，不再和 dashboard 仲裁。

     portfolio 是行源模型（每个活跃账户一行），只要请求成功它**永远有答案**，
     含 0。「它没有数据」不是一种状态，所以不存在「二选一」。

     曾经这里有两个数据源、`empty` 当开关：零快照（从没手填过快照，但 017 之后
     余额已经记在 `accounts.balance` 上）的用户会回落到 dashboard 的 Σbalance ——
     那是不含持仓市值的另一个口径，实测净资产 ¥114,170 被显示成 ¥28,000。
     现在唯一口径 = Σ(现金 + 持仓市值)，由服务端一次算好。
   */
  const portfolio = ref<PortfolioResponse | null>(null)
  /** 传输状态：pending = 还在飞；error = 失败且无缓存（读数不可知） */
  const portfolioState = ref<'pending' | 'ready' | 'error'>('pending')

  async function loadPortfolio() {
    /** 失败 = 传输报错 **或** HTTP 200 但 `code != 0`。两者同等对待。 */
    const unavailable = () => {
      if (portfolio.value == null) portfolioState.value = 'error'
    }
    try {
      const res = await api.get('/assets/portfolio')
      // 业务码不是 0 时也走失败路径：否则 portfolio 永远停在 pending，
      // 仪表就一直显示中性占位，既不报故障也永远不恢复。
      if (res.data.code !== 0) return unavailable()
      portfolio.value = res.data.data
      portfolioState.value = 'ready'
    } catch {
      // 失败时**不能**静默地长期拿 dashboard 的现金口径顶上：那是另一个口径，
      // 用户会看到一个更小的“净资产”却没有任何提示。有旧值就继续用旧值（同口径），
      // 一次都没成功过就标 error，让 UI 显示「—」。
      unavailable()
    }
  }

  /**
   * 净资产是不是一个**下界**。
   * 有账户的持仓没取到价时，那个账户只有现金被算进来，实际值 ≥ 显示值。
   * UI 必须显示「≥¥X」而不是把下界当精确值——曾经这里是静默少算、无任何提示。
   */
  const netWorthIncomplete = computed(() => portfolio.value?.netWorthComplete === false)
  const unpricedAccounts = computed<number>(() => portfolio.value?.unpricedAccounts ?? 0)
  /**
   * 净资产读数（分）。`null` = **不可知**，UI 必须显示「—」而不是编一个数。
   *
   * portfolio 已加载 → 它的数（唯一口径）。
   * 还在飞 → 暂时用 dashboard 的现金口径，免得首屏先闪一个 0（瞬态，不是口径仲裁）。
   * 加载失败 → `null`：宁可说“不知道”，也不长期静默显示另一个口径的更小的数。
   */
  const netWorth = computed<number | null>(() =>
    portfolio.value ? portfolio.value.netWorth
      : portfolioState.value === 'error' ? null
      : (data.value?.net_worth?.total ?? 0),
  )
  const netWorthUnknown = computed(() => netWorth.value == null)
  const netNegative = computed(() => (netWorth.value ?? 0) < 0)

  /**
   * 资产构成 —— **服务端算好的，只投影**。
   *
   * 分组（按账户总价值，不是现金）、percent、以及「没读数 / 全是负债」的空态
   * 全部是 `lib/portfolio.ts` 的口径决策（见 AssetComposition）。
   * 曾经在这里重算：漏过 percent（组件 `toFixed(0)` 抛错、构成整块不渲染），
   * 漏过空态（纯负债用户被说成「还没有记过余额」），还有一条永远走不到的死分支。
   * 本 store 不再持有任何口径，只做 key/label 重命名与空值兜底。
   */
  const assetSplit = computed(() =>
    (portfolio.value?.assetComposition?.rows ?? []).map((r) => ({
      key: r.type,
      label: r.type,
      value: r.value,
      percent: r.percent,
    })),
  )
  /**
   * 构成空态（服务端 `assetComposition.state` + 两个传输层状态）。
   * `pending` / `error` 是本 store 加的——它们是“读数还没到手 / 读不到”，
   * 不是“用户没记过账”，UI 对它们必须用中性占位而不是任何事实性文案。
   */
  const compositionState = computed<CompositionState>(() =>
    portfolio.value ? portfolio.value.assetComposition.state
      : portfolioState.value === 'error' ? 'error' : 'pending',
  )
  /** 负债（负余额账户合计）。唯一来源也是 portfolio，不再另立一套 */
  const liability = computed(() => portfolio.value?.liability ?? null)

  /* ── 读数 2：储蓄率（量程 0–100%，目标 30%） ── */
  const summary = computed(() => data.value?.summary ?? { expense: 0, income: 0, balance: 0, expense_change: null })
  const monthExpense = computed<number>(() => summary.value.expense ?? 0)
  const monthIncome = computed<number>(() => summary.value.income ?? 0)
  const monthBalance = computed<number>(() => monthIncome.value - monthExpense.value)
  const savingsRate = computed<number>(() =>
    monthIncome.value > 0 ? (monthBalance.value / monthIncome.value) * 100 : 0,
  )
  const savingsTone = computed<'ok' | 'amber' | 'redline' | 'neutral'>(() => {
    if (monthIncome.value <= 0) return 'neutral'
    if (savingsRate.value < 0) return 'redline'
    return savingsRate.value >= 30 ? 'ok' : 'amber'
  })

  /* ── 读数 3：本月支出 vs 上月（量程 0–150%，红区 120% 起） ──
     100% 刻度线 = 与上月持平。这个量程有参照物（上月），不是自我循环。 */
  const expenseChange = computed<number | null>(() => summary.value.expense_change ?? null)
  const expenseGaugePos = computed(() => {
    if (expenseChange.value == null) return 0
    return 50 + expenseChange.value * 0.833 // 150% 满量程
  })
  const expenseTone = computed<'neutral' | 'amber' | 'redline'>(() => {
    if (expenseChange.value == null) return 'neutral'
    if (expenseChange.value >= 20) return 'redline'
    if (expenseChange.value >= 5) return 'amber'
    return 'neutral'
  })

  /** 「更新于 2 分钟前」——仪表读数必须自报新鲜度，否则没人敢信 */
  const freshLabel = computed(() => {
    if (!updatedAt.value) return '未更新'
    const s = Math.floor((Date.now() - updatedAt.value) / 1000)
    if (s < 45) return '刚刚更新'
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
    return `${Math.floor(s / 86400)} 天前`
  })

  return {
    data, loading, error, updatedAt,
    load,
    netWorth, netWorthUnknown, netNegative, assetSplit, compositionState, liability,
    portfolio, portfolioState, loadPortfolio,
    netWorthIncomplete, unpricedAccounts,
    summary, monthExpense, monthIncome, monthBalance,
    savingsRate, savingsTone,
    expenseChange, expenseGaugePos, expenseTone,
    freshLabel,
  }
})
