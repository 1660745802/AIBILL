import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/index'

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
     两个来源，优先级很重要：
       1. portfolio（手动快照）——真实记录
       2. dashboard.net_worth（从流水回算）—— 551/553 笔交易没有 account_id，
          回算出来每个账户都是 0，只在没有快照时兜底
     快照为空时仪表要显示「去填」而不是一个假的 0。 */
  const portfolio = ref<any>(null)

  async function loadPortfolio() {
    try {
      const { data } = await api.get('/assets/portfolio')
      if (data.code === 0) portfolio.value = data.data
    } catch { /* 读不到就沿用回算值 */ }
  }

  const hasSnapshots = computed(() => portfolio.value?.empty === false)
  /**
   * 净资产是不是一个**下界**。
   * 有账户的持仓没取到价时，那个账户只有现金被算进来，实际值 ≥ 显示值。
   * UI 必须显示「≥¥X」而不是把下界当精确值——曾经这里是静默少算、无任何提示。
   */
  const netWorthIncomplete = computed(() => portfolio.value?.netWorthComplete === false)
  const unpricedAccounts = computed<number>(() => portfolio.value?.unpricedAccounts ?? 0)
  const netWorth = computed<number>(() => {
    if (hasSnapshots.value) return portfolio.value?.netWorth ?? 0
    return data.value?.net_worth?.total ?? 0
  })
  const netNegative = computed(() => netWorth.value < 0)

  /**
   * 资产构成（只算正余额的账户类型，转成占比）。
   *
   * **有快照时按 portfolio 的账户算**，不用 dashboard 的 asset_breakdown：
   * 后者是从流水回算的，而 551/553 笔交易没有 account_id，回算出来是空的——
   * 于是会出现「净资产 ¥114,170 / 构成写着『还没有账户』」这种自相矛盾。
   */
  const assetSplit = computed(() => {
    const rows: Array<{ key: string; label: string; value: number }> = []

    const snapAccounts = portfolio.value?.accounts ?? []
    if (snapAccounts.length > 0) {
      const byType = new Map<string, number>()
      for (const a of snapAccounts) {
        // 用账户总价值（持仓市值 + 现金），不是现金——否则理财账户会被算少
        const v = a.value ?? a.cash ?? 0
        if (v > 0) byType.set(a.assetType ?? 'other', (byType.get(a.assetType ?? 'other') ?? 0) + v)
      }
      for (const [type, value] of byType) rows.push({ key: type, label: type, value })
    } else {
      for (const b of data.value?.asset_breakdown ?? []) {
        if (b.total > 0) rows.push({ key: b.type, label: b.type, value: b.total })
      }
    }
    // ⚠️ percent 必须在这条共用路径上算。曾经从 portfolio 分支直接 return rows，
    //    绕过了下面的 percent 映射 → 组件里 `r.percent.toFixed(0)` 抛错 →
    //    构成横条整块渲染失败，页面上留下「还没有账户」的假象。
    const total = rows.reduce((s, r) => s + r.value, 0)
    return total > 0 ? rows.map(r => ({ ...r, percent: (r.value / total) * 100 })) : []
  })

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
    netWorth, netNegative, assetSplit,
    portfolio, hasSnapshots, loadPortfolio,
    netWorthIncomplete, unpricedAccounts,
    summary, monthExpense, monthIncome, monthBalance,
    savingsRate, savingsTone,
    expenseChange, expenseGaugePos, expenseTone,
    freshLabel,
  }
})
