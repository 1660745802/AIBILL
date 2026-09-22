<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from 'chart.js'
import api from '@/api/index'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

interface Summary {
  expense: number
  income: number
  balance: number
  expense_change: number | null
  income_change: number | null
  transaction_count: number
  saving_rate: number
}

interface NetWorth {
  total: number
  accounts: { id: number; name: string; icon: string; balance: number }[]
}

interface AssetBreakdownItem { type: string; total: number; count: number }
interface TrendItem { date: string; total: number }
interface CategoryItem { name: string; icon: string; total: number; percent: number }
interface BudgetItem { category_name: string; category_icon: string; amount: number; spent: number; percent: number; status: 'normal' | 'warning' | 'exceeded' }
interface AlertItem { type: string; message: string }
interface TransactionItem { id: number; type: 'expense' | 'income'; amount: number; description: string; category_name: string; category_icon: string; account_name: string; date: string }
interface GoalTopItem { id: number; name: string; icon: string; target_amount: number; current_amount: number; percent: number; remaining: number; deadline: string | null; estimated_completion: string | null }
interface SubscriptionsOverview { active_count: number; monthly_total: number; yearly_total: number }

interface DashboardData {
  summary: Summary
  net_worth: NetWorth
  total_liabilities: number
  asset_breakdown: AssetBreakdownItem[]
  trend_7days: TrendItem[]
  top_categories: CategoryItem[]
  budget_progress: BudgetItem[]
  alerts: AlertItem[]
  recent_transactions: TransactionItem[]
  goals_top: GoalTopItem[]
  subscriptions_overview: SubscriptionsOverview
}

const loading = ref(true)
const data = ref<DashboardData | null>(null)
const dismissedAlerts = ref(new Set<number>())

onMounted(() => fetchDashboard())

async function fetchDashboard() {
  try {
    const res = await api.get('/stats/dashboard')
    if (res.data.code === 0) data.value = res.data.data
  } catch { /* ignore */ }
  finally { loading.value = false }
}

function dismissAlert(i: number) { dismissedAlerts.value.add(i) }

// === 格式化 ===
function fmt(cents: number): string {
  return (Math.abs(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtK(cents: number): string {
  // 千元 / 万元 简写
  const yuan = Math.abs(cents) / 100
  if (yuan >= 100000000) return `${(yuan / 100000000).toFixed(2)}亿`
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(2)}万`
  if (yuan >= 1000) return `${(yuan / 1000).toFixed(1)}k`
  return yuan.toFixed(0)
}
function fmtDate(d: string): string {
  return d.slice(5)
}

// === 资产类型显示配置 ===
const ASSET_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  liquid:     { label: '活期',   color: '#3b82f6' },
  savings:    { label: '定期',   color: '#06b6d4' },
  investment: { label: '投资',   color: '#8b5cf6' },
  property:   { label: '不动产', color: '#f59e0b' },
  credit:     { label: '信用卡', color: '#ef4444' },
  loan:       { label: '贷款',   color: '#dc2626' },
  other:      { label: '其他',   color: '#9ca3af' },
}
function assetLabel(t: string) { return ASSET_TYPE_LABEL[t] || ASSET_TYPE_LABEL.other }

// 净资产是否正
const netPositive = computed(() => (data.value?.net_worth.total ?? 0) >= 0)

// 总资产（仅正值资产）
const totalAssets = computed(() => {
  if (!data.value) return 0
  return data.value.asset_breakdown
    .filter((b) => b.total > 0 && b.type !== 'credit' && b.type !== 'loan')
    .reduce((sum, b) => sum + b.total, 0)
})

// 资产分布条形图百分比（活期 vs 其他）
const assetBars = computed(() => {
  if (!data.value) return []
  const total = totalAssets.value || 1
  return data.value.asset_breakdown
    .filter((b) => b.total > 0 && b.type !== 'credit' && b.type !== 'loan')
    .map((b) => ({
      type: b.type,
      label: assetLabel(b.type).label,
      color: assetLabel(b.type).color,
      total: b.total,
      percent: Math.round((b.total / total) * 100),
    }))
    .sort((a, b) => b.total - a.total)
})

// 负债显示
const liabilityBars = computed(() => {
  if (!data.value) return []
  return data.value.asset_breakdown
    .filter((b) => b.total < 0 || b.type === 'credit' || b.type === 'loan')
    .map((b) => ({
      type: b.type,
      label: assetLabel(b.type).label,
      color: assetLabel(b.type).color,
      total: b.total,
    }))
})

// === 7 天趋势 ===
const trendChartData = computed(() => {
  if (!data.value) return { labels: [], datasets: [] }
  return {
    labels: data.value.trend_7days.map((d) => fmtDate(d.date)),
    datasets: [{
      data: data.value.trend_7days.map((d) => d.total / 100),
      borderColor: '#4f46e5',
      backgroundColor: 'rgba(79, 70, 229, 0.06)',
      fill: true,
      tension: 0.4,
      pointRadius: 3,
      pointBackgroundColor: '#4f46e5',
      borderWidth: 2,
    }],
  }
})

const trendChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `¥${ctx.parsed.y.toFixed(2)}` } } },
  scales: {
    y: { display: false, beginAtZero: true },
    x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 11 }, color: '#9ca3af' } },
  },
}

const visibleAlerts = computed(() => data.value?.alerts.filter((_, i) => !dismissedAlerts.value.has(i)) || [])

// 储蓄率颜色
function savingRateColor(rate: number): string {
  if (rate >= 30) return '#059669'
  if (rate >= 10) return '#f59e0b'
  return '#dc2626'
}
</script>

<template>
  <div class="pb-20 md:pb-4 space-y-4">
    <!-- Loading -->
    <div v-if="loading" class="space-y-4 animate-pulse">
      <div class="h-28 rounded-2xl" style="background: var(--color-border-light)"></div>
      <div class="grid grid-cols-4 gap-3">
        <div v-for="i in 4" :key="i" class="h-16 rounded-xl" style="background: var(--color-border-light)"></div>
      </div>
      <div class="h-32 rounded-xl" style="background: var(--color-border-light)"></div>
    </div>

    <template v-else-if="data">
      <!-- ============ 1. 净资产大卡片 ============ -->
      <div class="rounded-2xl p-5 text-white relative overflow-hidden"
           :style="{ background: netPositive ? 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)' : 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)' }">
        <div class="absolute top-0 right-0 w-32 h-32 rounded-full opacity-10" style="background: white; transform: translate(40%, -40%)"></div>
        <div class="flex items-start justify-between relative z-10">
          <div>
            <p class="text-xs opacity-80 mb-1">净资产</p>
            <p class="text-3xl font-bold amount-number">¥{{ fmt(data.net_worth.total) }}</p>
            <p class="text-[11px] opacity-75 mt-1">
              本月结余 ¥{{ fmt(data.summary.balance) }} · 储蓄率 {{ data.summary.saving_rate }}%
            </p>
          </div>
          <router-link to="/assets" class="text-xs opacity-80 hover:opacity-100 transition whitespace-nowrap self-start">
            资产详情 →
          </router-link>
        </div>
      </div>

      <!-- ============ 2. 四宫格状态 ============ -->
      <div class="grid grid-cols-4 gap-2.5">
        <div class="card text-center py-3">
          <p class="text-[10px] mb-1" style="color: var(--color-text-muted)">总资产</p>
          <p class="text-sm font-semibold amount-number">¥{{ fmtK(totalAssets) }}</p>
        </div>
        <div class="card text-center py-3">
          <p class="text-[10px] mb-1" style="color: var(--color-text-muted)">总负债</p>
          <p class="text-sm font-semibold amount-number" style="color: #dc2626">
            ¥{{ fmtK(data.total_liabilities) }}
          </p>
        </div>
        <div class="card text-center py-3">
          <p class="text-[10px] mb-1" style="color: var(--color-text-muted)">本月收入</p>
          <p class="text-sm font-semibold amount-number amount-income">¥{{ fmtK(data.summary.income) }}</p>
        </div>
        <div class="card text-center py-3">
          <p class="text-[10px] mb-1" style="color: var(--color-text-muted)">本月支出</p>
          <p class="text-sm font-semibold amount-number amount-expense">¥{{ fmtK(data.summary.expense) }}</p>
        </div>
      </div>

      <!-- ============ 3. 资产配置（条形） ============ -->
      <div v-if="assetBars.length > 0" class="card">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">资产配置</h3>
          <router-link to="/assets" class="text-[11px]" style="color: var(--color-primary-600)">详情 →</router-link>
        </div>
        <div class="space-y-2.5">
          <div v-for="bar in assetBars" :key="bar.type" class="flex items-center gap-3">
            <span class="text-xs w-12 shrink-0" style="color: var(--color-text-secondary)">{{ bar.label }}</span>
            <div class="flex-1 h-2 rounded-full overflow-hidden" style="background: var(--color-border-light)">
              <div class="h-full rounded-full transition-all" :style="{ width: `${bar.percent}%`, background: bar.color }"></div>
            </div>
            <span class="text-xs font-medium w-16 text-right amount-number" style="color: var(--color-text-secondary)">
              ¥{{ fmtK(bar.total) }}
            </span>
            <span class="text-[10px] w-9 text-right" style="color: var(--color-text-muted)">{{ bar.percent }}%</span>
          </div>
        </div>
        <div v-if="liabilityBars.length > 0" class="mt-3 pt-3" style="border-top: 1px dashed var(--color-border-light)">
          <div v-for="lb in liabilityBars" :key="lb.type" class="flex items-center gap-3 mb-1.5 last:mb-0">
            <span class="text-xs w-12 shrink-0" style="color: var(--color-text-muted)">{{ lb.label }}</span>
            <span class="text-xs amount-number" style="color: #dc2626">¥{{ fmt(lb.total) }}</span>
            <span v-if="lb.type === 'credit' || lb.type === 'loan'" class="text-[10px]" style="color: var(--color-text-muted)">(待还)</span>
          </div>
        </div>
      </div>

      <!-- ============ 4. 财务目标（Top 3） ============ -->
      <div v-if="data.goals_top.length > 0" class="card">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">财务目标</h3>
          <router-link to="/goals" class="text-[11px]" style="color: var(--color-primary-600)">全部 →</router-link>
        </div>
        <div class="space-y-3.5">
          <div v-for="g in data.goals_top" :key="g.id">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-1.5 min-w-0 flex-1">
                <span class="text-sm">{{ g.icon }}</span>
                <span class="text-sm truncate" style="color: var(--color-text-primary)">{{ g.name }}</span>
              </div>
              <span class="text-xs font-medium ml-2 amount-number" style="color: var(--color-text-secondary)">
                {{ g.percent }}%
              </span>
            </div>
            <div class="flex items-center gap-2">
              <div class="flex-1 h-1.5 rounded-full overflow-hidden" style="background: var(--color-border-light)">
                <div class="h-full rounded-full transition-all"
                  :style="{
                    width: `${g.percent}%`,
                    background: g.percent >= 100 ? '#059669' : g.percent >= 50 ? '#4f46e5' : '#a5b4fc',
                  }"></div>
              </div>
              <span class="text-[10px] w-20 text-right shrink-0" style="color: var(--color-text-muted)">
                ¥{{ fmtK(g.current_amount) }}/¥{{ fmtK(g.target_amount) }}
              </span>
            </div>
            <div v-if="g.estimated_completion" class="text-[10px] mt-1" style="color: var(--color-text-muted)">
              按当前节奏预计 {{ g.estimated_completion.slice(5) }} 完成
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 5. 预算 + 订阅（并排） ============ -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- 本月预算 -->
        <div v-if="data.budget_progress.length > 0" class="card">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">本月预算</h3>
            <router-link to="/budget" class="text-[11px]" style="color: var(--color-primary-600)">设置 →</router-link>
          </div>
          <div class="space-y-3">
            <div v-for="b in data.budget_progress.slice(0, 4)" :key="b.category_name">
              <div class="flex justify-between items-center mb-1">
                <span class="text-xs" style="color: var(--color-text-secondary)">{{ b.category_icon }} {{ b.category_name }}</span>
                <span class="text-[10px]" style="color: var(--color-text-muted)">{{ b.percent }}%</span>
              </div>
              <div class="h-1.5 rounded-full overflow-hidden" style="background: var(--color-border-light)">
                <div class="h-full rounded-full"
                  :style="{
                    width: `${Math.min(b.percent, 100)}%`,
                    background: b.status === 'exceeded' ? '#dc2626' : b.status === 'warning' ? '#f59e0b' : '#059669'
                  }"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 订阅概览 -->
        <div v-if="data.subscriptions_overview.active_count > 0" class="card">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">订阅</h3>
            <router-link to="/subscriptions" class="text-[11px]" style="color: var(--color-primary-600)">管理 →</router-link>
          </div>
          <div class="flex items-baseline gap-2 mb-1">
            <span class="text-2xl font-bold amount-number">¥{{ fmt(data.subscriptions_overview.monthly_total) }}</span>
            <span class="text-xs" style="color: var(--color-text-muted)">/ 月</span>
          </div>
          <p class="text-[11px] mb-3" style="color: var(--color-text-muted)">
            {{ data.subscriptions_overview.active_count }} 个活跃订阅 · 年化 ¥{{ fmt(data.subscriptions_overview.yearly_total) }}
          </p>
          <div class="text-[11px] px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5"
               style="background: var(--color-border-light); color: var(--color-text-secondary)">
            <span>💡</span>
            <span>订阅支出占本月支出 {{ data.summary.expense > 0 ? Math.round((data.subscriptions_overview.monthly_total * 100) / data.summary.expense) : 0 }}%</span>
          </div>
        </div>
      </div>

      <!-- ============ 6. 待办提醒 ============ -->
      <div v-if="visibleAlerts.length > 0" class="card">
        <div class="flex items-center justify-between mb-2.5">
          <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">
            待办
            <span class="ml-1 text-[10px] px-1.5 py-0.5 rounded-full" style="background: var(--color-primary-100); color: var(--color-primary-700)">
              {{ visibleAlerts.length }}
            </span>
          </h3>
        </div>
        <div class="space-y-2">
          <div
            v-for="(alert, i) in data.alerts"
            :key="i"
            v-show="!dismissedAlerts.has(i)"
            class="flex items-center gap-2.5 py-2 px-3 rounded-lg text-sm"
            :style="alert.type.includes('exceeded') || alert.type === 'large_expense'
              ? 'background: #fef2f2; color: #991b1b'
              : alert.type === 'subscription_due'
              ? 'background: #eff6ff; color: #1e40af'
              : 'background: #fffbeb; color: #92400e'"
          >
            <span class="text-sm shrink-0">
              {{ alert.type.includes('exceeded') || alert.type === 'large_expense' ? '🔴'
                  : alert.type === 'subscription_due' ? '📅'
                  : '⚠️' }}
            </span>
            <span class="flex-1 text-xs">{{ alert.message }}</span>
            <button @click="dismissAlert(i)" class="text-xs opacity-40 hover:opacity-100 shrink-0">✕</button>
          </div>
        </div>
      </div>

      <!-- ============ 7. 7 日趋势 + Top 分类（并排） ============ -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="card">
          <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">近 7 日支出</h3>
          <div class="h-32">
            <Line v-if="data.trend_7days.some((d) => d.total > 0)" :data="trendChartData" :options="trendChartOptions" />
            <div v-else class="flex items-center justify-center h-full text-sm" style="color: var(--color-text-muted)">暂无数据</div>
          </div>
        </div>

        <div v-if="data.top_categories.length > 0" class="card">
          <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">支出分类 Top 5</h3>
          <div class="space-y-2.5">
            <div v-for="cat in data.top_categories" :key="cat.name" class="flex items-center gap-2.5">
              <span class="text-sm w-5 text-center">{{ cat.icon }}</span>
              <span class="text-xs w-12 truncate" style="color: var(--color-text-secondary)">{{ cat.name }}</span>
              <div class="flex-1 h-1.5 rounded-full overflow-hidden" style="background: var(--color-border-light)">
                <div class="h-full rounded-full" style="background: var(--color-primary-500); width: `${cat.percent}%`"></div>
              </div>
              <span class="text-[10px] w-12 text-right font-medium amount-number" style="color: var(--color-text-secondary)">¥{{ fmtK(cat.total) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 8. 最近交易 ============ -->
      <div class="card">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">最近交易</h3>
          <router-link to="/ledger" class="text-[11px]" style="color: var(--color-primary-600)">全部 →</router-link>
        </div>
        <div v-if="data.recent_transactions.length > 0" class="space-y-2">
          <div v-for="tx in data.recent_transactions" :key="tx.id" class="flex items-center gap-3">
            <span class="text-sm w-5 text-center">{{ tx.category_icon }}</span>
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate" style="color: var(--color-text-primary)">{{ tx.description || tx.category_name }}</p>
              <p class="text-[10px]" style="color: var(--color-text-muted)">{{ tx.account_name }} · {{ fmtDate(tx.date) }}</p>
            </div>
            <span class="text-sm font-medium amount-number shrink-0"
              :class="tx.type === 'expense' ? 'amount-expense' : 'amount-income'">
              {{ tx.type === 'expense' ? '-' : '+' }}¥{{ fmt(tx.amount) }}
            </span>
          </div>
        </div>
        <div v-else class="text-center py-6 text-sm" style="color: var(--color-text-muted)">
          还没有记录，<router-link to="/quick" style="color: var(--color-primary-600)">记一笔</router-link>
        </div>
      </div>

      <!-- ============ 9. 快捷入口 ============ -->
      <div class="grid grid-cols-3 gap-3">
        <router-link to="/quick" class="card card-hover flex flex-col items-center py-4 text-center">
          <svg class="w-5 h-5 mb-1.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="color: var(--color-primary-600)">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span class="text-xs font-medium" style="color: var(--color-text-primary)">记一笔</span>
        </router-link>
        <router-link to="/ledger" class="card card-hover flex flex-col items-center py-4 text-center">
          <svg class="w-5 h-5 mb-1.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="color: var(--color-primary-600)">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <span class="text-xs font-medium" style="color: var(--color-text-primary)">看流水</span>
        </router-link>
        <router-link to="/ai" class="card card-hover flex flex-col items-center py-4 text-center">
          <svg class="w-5 h-5 mb-1.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="color: var(--color-primary-600)">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          <span class="text-xs font-medium" style="color: var(--color-text-primary)">问 AI</span>
        </router-link>
      </div>
    </template>
  </div>
</template>