<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip,
} from 'chart.js'
import api from '@/api/index'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import Notice from '@/components/ui/Notice.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useChartColors, ink } from '@/utils/chart'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

interface AssetBreakdownItem { type: string; total: number; count: number }
interface TrendItem { date: string; total: number }
interface AlertItem { type: string; message: string }

const loading = ref(true)
const data = ref<any | null>(null)
const dismissed = ref<Set<number>>(new Set())

onMounted(fetchDashboard)

async function fetchDashboard() {
  try {
    const res = await api.get('/stats/dashboard')
    if (res.data.code === 0) data.value = res.data.data
  } catch { /* ignore */ } finally { loading.value = false }
}

const ASSET_META: Record<string, { label: string; color: string }> = {
  liquid: { label: '活期', color: 'var(--color-action)' },
  savings: { label: '定期', color: 'var(--color-info)' },
  investment: { label: '投资', color: 'var(--color-ink-3)' },
  property: { label: '不动产', color: 'var(--color-warn)' },
  credit: { label: '信用卡', color: 'var(--color-expense)' },
  loan: { label: '贷款', color: 'var(--color-expense)' },
  other: { label: '其他', color: 'var(--color-ink-4)' },
}
const OTHER_ASSET = { label: '其他', color: 'var(--color-ink-4)' }
const assetMeta = (t: string) => ASSET_META[t] ?? OTHER_ASSET

const assetRows = computed(() => {
  if (!data.value) return []
  const items = data.value.asset_breakdown.filter(
    (b: AssetBreakdownItem) => b.total > 0 && b.type !== 'credit' && b.type !== 'loan',
  )
  const total = items.reduce((s: number, b: AssetBreakdownItem) => s + b.total, 0) || 1
  return items
    .map((b: AssetBreakdownItem) => ({
      type: b.type,
      label: assetMeta(b.type).label,
      color: assetMeta(b.type).color,
      total: b.total,
      percent: Math.round((b.total / total) * 100),
    }))
    .sort((a: any, b: any) => b.total - a.total)
})

const liabilityRows = computed(() =>
  (data.value?.asset_breakdown ?? []).filter(
    (b: AssetBreakdownItem) => b.total < 0 || b.type === 'credit' || b.type === 'loan',
  ),
)

const { schemeTick } = useChartColors()

const trendChartData = computed(() => {
  void schemeTick.value // 配色方案变化时重绘
  const main = ink.strong
  return {
    labels: (data.value?.trend_7days ?? []).map((d: TrendItem) => d.date.slice(5)),
    datasets: [{
      data: (data.value?.trend_7days ?? []).map((d: TrendItem) => d.total / 100),
      borderColor: main,
      backgroundColor: 'rgba(127,127,127,0.10)',
      fill: true, tension: 0.38, borderWidth: 1.75, pointRadius: 2.5,
      pointBackgroundColor: main, pointBorderWidth: 0,
    }],
  }
})

const trendChartOptions = computed(() => ({
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { displayColors: false, callbacks: { label: (c: any) => `¥${c.parsed.y.toFixed(2)}` } },
  },
  scales: {
    y: { display: false, beginAtZero: true },
    x: {
      grid: { display: false },
      border: { display: false },
      ticks: { font: { size: 10 }, color: ink.mid, maxRotation: 0 },
    },
  },
}))

const hasTrend = computed(() => (data.value?.trend_7days ?? []).some((d: TrendItem) => d.total > 0))

const visibleAlerts = computed(() =>
  (data.value?.alerts ?? []).filter((_: AlertItem, i: number) => !dismissed.value.has(i)),
)

/** 首次使用：一个数据都没有，插引导块而不是让人对着空页面发呆 */
const isFirstRun = computed(() => {
  if (!data.value) return false
  return data.value.summary.transaction_count === 0
    && (data.value.net_worth?.total ?? 0) === 0
    && (data.value.net_worth?.accounts?.length ?? 0) === 0
})

const alertTone = (t: string) =>
  t.includes('exceeded') || t === 'large_expense' ? 'danger'
    : t === 'subscription_due' ? 'info' : 'warn'

/** 「这个月走到哪了」——仪表给钱，这里给时间进度，两件事不重复 */
const monthProgress = computed(() => {
  const now = new Date()
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const count = data.value?.summary?.transaction_count ?? 0
  return `${now.getMonth() + 1} 月已过 ${now.getDate()} / ${days} 天 · 已记 ${count} 笔`
})
</script>

<template>
  <div class="space-y-6">
    <!-- 报头：周期与读数都在仪表面上，这里只回答「这个月走到哪了」 -->
    <div class="dash-masthead">
      <div>
        <h1 class="text-lg font-semibold" style="color: var(--color-ink-1)">本月</h1>
        <p class="text-[0.75rem] mt-0.5" style="color: var(--color-ink-3)">{{ monthProgress }}</p>
      </div>
    </div>

    <!-- 加载 -->
    <div v-if="loading" class="space-y-6">
      <div class="skeleton h-24 rounded-lg" />
      <div class="grid lg:grid-cols-2 gap-6">
        <div class="skeleton h-44 rounded-lg" />
        <div class="skeleton h-44 rounded-lg" />
      </div>
    </div>

    <div v-else-if="data" class="grid lg:grid-cols-[minmax(0,1fr)_21rem] gap-6 items-start">
      <!-- ═══ 主栏 ═══
           净资产 / 本月支出 / 储蓄率 三块读数已由常驻仪表面承担，页面里不重复：
           仪表回答「我现在什么状况」，本页回答「为什么」。
           所以主栏从待办和趋势开始，进来第一眼是事情，不是数字。      -->
      <div class="space-y-6 min-w-0">

        <!-- 首次使用引导 -->
        <section v-if="isFirstRun" class="surface p-4">
          <LedgerLabel>从这里开始</LedgerLabel>
          <p class="text-sm leading-relaxed" style="color: var(--color-ink-2)">
            还没有任何记录。先写一句话试试，比如
            <span class="chip !h-auto !py-0.5 align-middle">午饭 32，打车 15</span>
            ，AI 会自动拆成两笔。也支持从微信、支付宝导入历史账单。
          </p>
          <div class="flex flex-wrap gap-2 mt-3.5">
            <router-link to="/" class="btn btn-primary btn-sm">
              <AppIcon name="pen" :size="13" />记第一笔
            </router-link>
            <router-link to="/import" class="btn btn-outline btn-sm">
              <AppIcon name="upload" :size="13" />导入账单
            </router-link>
          </div>
        </section>

        <!-- 待办 -->
        <section v-if="visibleAlerts.length" class="space-y-2">
          <LedgerLabel :count="visibleAlerts.length">待办</LedgerLabel>
          <Notice
            v-for="(alert, i) in data.alerts"
            :key="i"
            v-show="!dismissed.has(i)"
            :tone="alertTone(alert.type)"
            @close="dismissed.add(i)"
          >{{ alert.message }}</Notice>
        </section>

        <!-- 近 7 日支出 -->
        <section class="surface p-4">
          <LedgerLabel>近 7 日支出</LedgerLabel>
          <div v-if="hasTrend" class="h-32 -ml-1">
            <Line :data="trendChartData" :options="trendChartOptions" />
          </div>
          <EmptyState v-else compact icon="chart" title="这一周还没有支出" description="记一笔之后这里会出现趋势曲线" />
        </section>

        <!-- 最近交易 -->
        <section class="sheet">
          <header class="flex items-center justify-between px-3.5 py-2.5"
                  style="border-bottom: 1px solid var(--color-rule); background: var(--color-paper-sunk)">
            <span class="ledger-label ledger-label-solid text-[0.6875rem] font-semibold tracking-[0.06em]"
                  style="color: var(--color-ink-3)">最近交易</span>
            <router-link to="/ledger" class="act">全部 →</router-link>
          </header>

          <EmptyState
            v-if="!data.recent_transactions.length"
            compact
            ruled
            icon="pen"
            title="还没有交易记录"
            description="在上面写一句话就能记一笔"
          >
            <router-link to="/" class="btn btn-primary btn-sm">去记一笔</router-link>
          </EmptyState>

      <template v-else>
        <SheetRow v-for="tx in data.recent_transactions" :key="tx.id" clickable>
          <span class="tx-icon" aria-hidden="true">{{ tx.category_icon || '📦' }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-[0.8125rem] truncate" style="color: var(--color-ink-1)">
              {{ tx.description || tx.category_name }}
            </span>
            <span class="block text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
              {{ tx.account_name }} · {{ tx.date.slice(5, 10) }}
            </span>
          </span>
          <Money :value="tx.amount" :tone="tx.type === 'expense' ? 'expense' : 'income'" />
        </SheetRow>
      </template>
        </section>
      </div>

      <!-- ═══ 侧栏 ═══ -->
      <aside class="space-y-6 lg:sticky lg:top-6 min-w-0">
        <!-- 资产配置 -->
        <section class="surface p-4">
          <LedgerLabel>
            资产配置
            <template #end><router-link to="/assets" class="act">详情</router-link></template>
          </LedgerLabel>

          <template v-if="assetRows.length">
            <!-- 堆叠条 -->
            <div class="flex h-1.5 rounded-full overflow-hidden gap-px mb-3">
              <div v-for="a in assetRows" :key="a.type"
                   :style="{ width: a.percent + '%', background: a.color }" />
            </div>
            <ul class="space-y-2">
              <li v-for="a in assetRows" :key="a.type" class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-xs shrink-0" :style="{ background: a.color }" aria-hidden="true" />
                <span class="text-xs flex-1 truncate" style="color: var(--color-ink-2)">{{ a.label }}</span>
                <Money :value="a.total" sign="none" size="sm" tone="muted" />
                <span class="text-[0.625rem] amt w-8 text-right" style="color: var(--color-ink-4)">{{ a.percent }}%</span>
              </li>
            </ul>
            <div v-if="liabilityRows.length" class="mt-3 pt-3 space-y-1.5"
                 style="border-top: 1px dashed var(--color-rule)">
              <div v-for="l in liabilityRows" :key="l.type" class="flex items-center justify-between gap-2">
                <span class="text-[0.6875rem]" style="color: var(--color-ink-3)">{{ assetMeta(l.type).label }}</span>
                <Money :value="l.total" size="sm" tone="expense" />
              </div>
            </div>
          </template>

          <EmptyState v-else compact icon="wallet" title="还没有账户"
                      description="添加账户后这里会显示资产分布">
            <router-link to="/settings" class="btn btn-outline btn-sm">去添加</router-link>
          </EmptyState>
        </section>

        <!-- 快捷入口：只留导航里没有的。账本 / 助手 / 记一笔
             分别是侧栏项、侧栏项、侧栏动作，再列一遍只会让人不知道该点哪个。 -->
        <router-link to="/trash" class="sheet sheet-row sheet-row-click">
          <AppIcon name="trash" :size="16" class="text-ink-3" />
          <span class="flex-1 text-[0.8125rem]" style="color: var(--color-ink-1)">回收站</span>
          <AppIcon name="chevronRight" :size="14" class="chev-link" />
        </router-link>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.dash-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-rule);
}
</style>
