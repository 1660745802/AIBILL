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
}

interface NetWorth {
  total: number
  accounts: { id: number; name: string; icon: string; balance: number }[]
}

interface TrendItem {
  date: string
  total: number
}

interface CategoryItem {
  name: string
  icon: string
  total: number
  percent: number
}

interface BudgetItem {
  category_name: string
  category_icon: string
  amount: number
  spent: number
  percent: number
  status: 'normal' | 'warning' | 'exceeded'
}

interface AlertItem {
  type: string
  message: string
}

interface TransactionItem {
  id: number
  type: 'expense' | 'income'
  amount: number
  description: string
  category_name: string
  category_icon: string
  account_name: string
  date: string
}

interface DashboardData {
  summary: Summary
  net_worth: NetWorth
  trend_7days: TrendItem[]
  top_categories: CategoryItem[]
  budget_progress: BudgetItem[]
  alerts: AlertItem[]
  recent_transactions: TransactionItem[]
}

const loading = ref(true)
const refreshing = ref(false)
const data = ref<DashboardData | null>(null)
const dismissedAlerts = ref<Set<number>>(new Set())

// AI 洞察
const aiInsight = ref('')
const aiInsightLoading = ref(false)

// Pull-to-refresh state
const pullStartY = ref(0)
const pullDistance = ref(0)
const isPulling = ref(false)
const pullThreshold = 80

onMounted(() => {
  fetchDashboard()
})

async function fetchDashboard() {
  try {
    const res = await api.get('/stats/dashboard')
    if (res.data.code === 0) {
      data.value = res.data.data
    }
  } catch {
    /* ignore */
  } finally {
    loading.value = false
    refreshing.value = false
    pullDistance.value = 0
    isPulling.value = false
  }
}

async function refresh() {
  refreshing.value = true
  await fetchDashboard()
}

async function fetchAiInsight() {
  if (aiInsightLoading.value) return
  aiInsightLoading.value = true
  try {
    const { data: res } = await api.post('/stats/analysis', { type: 'overview' }, { timeout: 30000 })
    if (res.code === 0 && res.data?.analysis) {
      // 取第一段作为一句话洞察
      const lines = res.data.analysis.split('\n').filter((l: string) => l.trim())
      aiInsight.value = lines.slice(0, 3).join('\n')
    }
  } catch { /* ignore */ }
  finally { aiInsightLoading.value = false }
}

function onTouchStart(e: TouchEvent) {
  const scrollTop = document.documentElement.scrollTop || document.body.scrollTop
  if (scrollTop === 0) {
    pullStartY.value = e.touches[0]!.clientY
    isPulling.value = true
  }
}

function onTouchMove(e: TouchEvent) {
  if (!isPulling.value) return
  const diff = e.touches[0]!.clientY - pullStartY.value
  if (diff > 0) {
    pullDistance.value = Math.min(diff * 0.5, 120)
  }
}

function onTouchEnd() {
  if (pullDistance.value >= pullThreshold) {
    refresh()
  } else {
    pullDistance.value = 0
    isPulling.value = false
  }
}

function dismissAlert(index: number) {
  dismissedAlerts.value.add(index)
}

function formatAmount(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

// 7-day trend chart
const trendChartData = computed(() => {
  if (!data.value) return { labels: [], datasets: [] }
  return {
    labels: data.value.trend_7days.map((d) => formatDate(d.date)),
    datasets: [
      {
        data: data.value.trend_7days.map((d) => d.total / 100),
        borderColor: '#ef4444',
        backgroundColor: (ctx: any) => {
          const chart = ctx.chart
          const { ctx: canvasCtx, chartArea } = chart
          if (!chartArea) return 'rgba(239, 68, 68, 0.1)'
          const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
          gradient.addColorStop(0, 'rgba(239, 68, 68, 0.2)')
          gradient.addColorStop(1, 'rgba(239, 68, 68, 0.0)')
          return gradient
        },
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#ef4444',
        borderWidth: 2,
      },
    ],
  }
})

const trendChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: (ctx: any) => `¥${ctx.parsed.y.toFixed(2)}`,
      },
    },
  },
  scales: {
    y: {
      display: false,
      beginAtZero: true,
    },
    x: {
      grid: { display: false },
      border: { display: false },
      ticks: { font: { size: 11 }, color: '#9ca3af' },
    },
  },
}

const categoryColors = ['#ef4444', '#f97316', '#eab308', '#06b6d4', '#8b5cf6']

const visibleAlerts = computed(() => {
  if (!data.value) return []
  return data.value.alerts.filter((_, i) => !dismissedAlerts.value.has(i))
})
</script>

<template>
  <div
    class="pb-20 md:pb-4 relative"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd"
  >
    <!-- Pull-to-refresh indicator -->
    <Transition
      enter-active-class="transition-all duration-200"
      leave-active-class="transition-all duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="pullDistance > 0 || refreshing"
        class="flex items-center justify-center py-3 text-sm text-gray-400"
        :style="{ height: `${refreshing ? 40 : pullDistance}px` }"
      >
        <span v-if="refreshing" class="animate-spin mr-2">⟳</span>
        <span>{{ refreshing ? '刷新中...' : pullDistance >= pullThreshold ? '松开刷新' : '下拉刷新' }}</span>
      </div>
    </Transition>

    <!-- Loading Skeleton -->
    <div v-if="loading" class="p-4 space-y-4 animate-pulse">
      <!-- Summary skeleton -->
      <div class="grid grid-cols-3 gap-3">
        <div class="h-24 rounded-2xl bg-gray-200"></div>
        <div class="h-24 rounded-2xl bg-gray-200"></div>
        <div class="h-24 rounded-2xl bg-gray-200"></div>
      </div>
      <!-- Net worth skeleton -->
      <div class="h-16 rounded-2xl bg-gray-200"></div>
      <!-- Chart skeleton -->
      <div class="h-44 rounded-2xl bg-gray-200"></div>
      <!-- Category skeleton -->
      <div class="space-y-3">
        <div class="h-10 rounded-lg bg-gray-200"></div>
        <div class="h-10 rounded-lg bg-gray-200"></div>
        <div class="h-10 rounded-lg bg-gray-200"></div>
      </div>
    </div>

    <!-- Dashboard Content -->
    <div v-else-if="data" class="p-4 space-y-4">
      <!-- Section 1: Summary Cards -->
      <div class="grid grid-cols-3 gap-3">
        <!-- 支出 -->
        <div class="bg-gradient-to-br from-red-500 to-rose-500 rounded-2xl p-3 text-white shadow-sm">
          <div class="text-xs opacity-80">本月支出</div>
          <div class="text-lg font-bold mt-1 truncate">¥{{ formatAmount(data.summary.expense) }}</div>
          <div v-if="data.summary.expense_change !== null" class="mt-1">
            <span class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-white/20">
              {{ data.summary.expense_change > 0 ? '↑' : '↓' }}{{ Math.abs(data.summary.expense_change) }}%
            </span>
          </div>
        </div>
        <!-- 收入 -->
        <div class="bg-gradient-to-br from-emerald-500 to-green-500 rounded-2xl p-3 text-white shadow-sm">
          <div class="text-xs opacity-80">本月收入</div>
          <div class="text-lg font-bold mt-1 truncate">¥{{ formatAmount(data.summary.income) }}</div>
          <div v-if="data.summary.income_change !== null" class="mt-1">
            <span class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-white/20">
              {{ data.summary.income_change > 0 ? '↑' : '↓' }}{{ Math.abs(data.summary.income_change) }}%
            </span>
          </div>
        </div>
        <!-- 结余 -->
        <div class="bg-gradient-to-br from-blue-500 to-indigo-500 rounded-2xl p-3 text-white shadow-sm">
          <div class="text-xs opacity-80">结余</div>
          <div class="text-lg font-bold mt-1 truncate">¥{{ formatAmount(data.summary.balance) }}</div>
          <div class="mt-1">
            <span class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-white/20">
              {{ data.summary.transaction_count }}笔
            </span>
          </div>
        </div>
      </div>

      <!-- Net Worth -->
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-500">净资产</span>
          <span class="text-lg font-bold text-gray-800">¥{{ formatAmount(data.net_worth.total) }}</span>
        </div>
        <div v-if="data.net_worth.accounts.length > 0" class="mt-2 flex flex-wrap gap-2">
          <span
            v-for="acc in data.net_worth.accounts"
            :key="acc.id"
            class="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 px-2 py-1 rounded-lg"
          >
            <span>{{ acc.icon }}</span>
            <span>{{ acc.name }}</span>
            <span class="font-medium text-gray-700">¥{{ formatAmount(acc.balance) }}</span>
          </span>
        </div>
      </div>

      <!-- Section 2: 7-Day Trend Chart -->
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <h3 class="text-sm font-medium text-gray-700 mb-3">近7日支出趋势</h3>
        <div class="h-40">
          <Line
            v-if="data.trend_7days.some((d) => d.total > 0)"
            :data="trendChartData"
            :options="trendChartOptions"
          />
          <div v-else class="flex items-center justify-center h-full text-sm text-gray-400">
            暂无支出数据
          </div>
        </div>
      </div>

      <!-- Section 3: Category Breakdown (Top 5) -->
      <div v-if="data.top_categories.length > 0" class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <h3 class="text-sm font-medium text-gray-700 mb-3">支出分类 TOP5</h3>
        <div class="space-y-3">
          <div v-for="(cat, index) in data.top_categories" :key="cat.name" class="flex items-center gap-3">
            <span class="text-lg">{{ cat.icon }}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm text-gray-700">{{ cat.name }}</span>
                <span class="text-sm font-medium text-gray-600">¥{{ formatAmount(cat.total) }}</span>
              </div>
              <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-500"
                  :style="{ width: `${cat.percent}%`, backgroundColor: categoryColors[index] }"
                ></div>
              </div>
            </div>
            <span class="text-xs text-gray-400 w-10 text-right">{{ cat.percent }}%</span>
          </div>
        </div>
      </div>

      <!-- Section 4: Budget Progress -->
      <div v-if="data.budget_progress.length > 0" class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <h3 class="text-sm font-medium text-gray-700 mb-3">预算进度</h3>
        <div class="space-y-3">
          <div v-for="budget in data.budget_progress" :key="budget.category_name" class="space-y-1.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-base">{{ budget.category_icon }}</span>
                <span class="text-sm text-gray-700">{{ budget.category_name }}</span>
              </div>
              <div class="text-xs text-gray-500">
                <span class="font-medium" :class="{
                  'text-gray-700': budget.status === 'normal',
                  'text-amber-600': budget.status === 'warning',
                  'text-red-600': budget.status === 'exceeded',
                }">¥{{ formatAmount(budget.spent) }}</span>
                <span> / ¥{{ formatAmount(budget.amount) }}</span>
              </div>
            </div>
            <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="{
                  'bg-emerald-500': budget.status === 'normal',
                  'bg-amber-500': budget.status === 'warning',
                  'bg-red-500': budget.status === 'exceeded',
                }"
                :style="{ width: `${Math.min(budget.percent, 100)}%` }"
              ></div>
            </div>
            <div class="text-right">
              <span
                class="text-[10px] px-1.5 py-0.5 rounded-full"
                :class="{
                  'bg-emerald-50 text-emerald-600': budget.status === 'normal',
                  'bg-amber-50 text-amber-600': budget.status === 'warning',
                  'bg-red-50 text-red-600': budget.status === 'exceeded',
                }"
              >
                {{ budget.percent }}%
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 5: Alerts -->
      <div v-if="visibleAlerts.length > 0" class="space-y-2">
        <TransitionGroup
          enter-active-class="transition-all duration-300"
          leave-active-class="transition-all duration-200"
          enter-from-class="opacity-0 -translate-y-2"
          enter-to-class="opacity-100 translate-y-0"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 translate-x-4"
        >
          <div
            v-for="(alert, index) in data.alerts"
            :key="index"
            v-show="!dismissedAlerts.has(index)"
            class="flex items-center gap-3 rounded-2xl p-3 shadow-sm border"
            :class="{
              'bg-amber-50 border-amber-200': alert.type === 'budget_warning',
              'bg-red-50 border-red-200': alert.type === 'budget_exceeded' || alert.type === 'large_expense',
            }"
          >
            <span class="text-lg">
              {{ alert.type === 'budget_warning' ? '⚠️' : '🚨' }}
            </span>
            <span class="flex-1 text-sm" :class="{
              'text-amber-700': alert.type === 'budget_warning',
              'text-red-700': alert.type === 'budget_exceeded' || alert.type === 'large_expense',
            }">
              {{ alert.message }}
            </span>
            <button
              @click="dismissAlert(index)"
              class="text-gray-400 hover:text-gray-600 p-1"
            >
              ✕
            </button>
          </div>
        </TransitionGroup>
      </div>

      <!-- Section 6: Recent Transactions -->
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <h3 class="text-sm font-medium text-gray-700 mb-3">最近交易</h3>
        <div v-if="data.recent_transactions.length > 0" class="space-y-3">
          <div
            v-for="tx in data.recent_transactions"
            :key="tx.id"
            class="flex items-center gap-3"
          >
            <span class="text-lg">{{ tx.category_icon }}</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-gray-800 truncate">{{ tx.description }}</div>
              <div class="text-xs text-gray-400">{{ tx.account_name }} · {{ formatDate(tx.date) }}</div>
            </div>
            <span
              class="text-sm font-medium"
              :class="tx.type === 'expense' ? 'text-red-500' : 'text-emerald-500'"
            >
              {{ tx.type === 'expense' ? '-' : '+' }}¥{{ formatAmount(tx.amount) }}
            </span>
          </div>
        </div>
        <div v-else class="text-center py-4 text-sm text-gray-400">暂无交易记录</div>
      </div>

      <!-- Quick Actions -->
      <div class="grid grid-cols-3 gap-3">
        <router-link
          to="/quick"
          class="flex flex-col items-center py-4 bg-white rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow"
        >
          <span class="text-2xl mb-1">✏️</span>
          <span class="text-xs text-gray-700 font-medium">记一笔</span>
        </router-link>
        <router-link
          to="/ledger"
          class="flex flex-col items-center py-4 bg-white rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow"
        >
          <span class="text-2xl mb-1">📒</span>
          <span class="text-xs text-gray-700 font-medium">看流水</span>
        </router-link>
        <router-link
          to="/ai"
          class="flex flex-col items-center py-4 bg-white rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow"
        >
          <span class="text-2xl mb-1">🤖</span>
          <span class="text-xs text-gray-700 font-medium">问问 AI</span>
        </router-link>
      </div>

      <!-- AI 洞察 -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="h-1 bg-gradient-to-r from-purple-400 to-blue-400"></div>
        <div class="p-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-medium text-gray-700">🧠 AI 洞察</h3>
            <button
              v-if="!aiInsight"
              @click="fetchAiInsight"
              :disabled="aiInsightLoading"
              class="text-xs px-2.5 py-1 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 disabled:opacity-50"
            >
              {{ aiInsightLoading ? '分析中...' : '生成' }}
            </button>
            <button
              v-else
              @click="fetchAiInsight"
              :disabled="aiInsightLoading"
              class="text-xs text-gray-400 hover:text-blue-500"
            >
              {{ aiInsightLoading ? '...' : '刷新' }}
            </button>
          </div>
          <div v-if="aiInsight" class="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{{ aiInsight }}</div>
          <div v-else-if="aiInsightLoading" class="flex items-center gap-2 py-2">
            <span class="w-4 h-4 border-2 border-purple-200 border-t-purple-500 rounded-full animate-spin"></span>
            <span class="text-xs text-gray-400">AI 正在分析你的财务数据...</span>
          </div>
          <div v-else class="text-xs text-gray-400 py-1">点击"生成"获取 AI 财务洞察</div>
        </div>
      </div>
    </div>
  </div>
</template>
