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

interface TrendItem { date: string; total: number }
interface CategoryItem { name: string; icon: string; total: number; percent: number }
interface BudgetItem { category_name: string; category_icon: string; amount: number; spent: number; percent: number; status: 'normal' | 'warning' | 'exceeded' }
interface AlertItem { type: string; message: string }
interface TransactionItem { id: number; type: 'expense' | 'income'; amount: number; description: string; category_name: string; category_icon: string; account_name: string; date: string }

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
const data = ref<DashboardData | null>(null)
const dismissedAlerts = ref<Set<number>>(new Set())
const aiInsight = ref('')
const aiInsightLoading = ref(false)

onMounted(() => fetchDashboard())

async function fetchDashboard() {
  try {
    const res = await api.get('/stats/dashboard')
    if (res.data.code === 0) data.value = res.data.data
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function fetchAiInsight() {
  if (aiInsightLoading.value) return
  aiInsightLoading.value = true
  try {
    const { data: res } = await api.post('/stats/analysis', { type: 'overview' }, { timeout: 30000 })
    if (res.code === 0 && res.data?.analysis) {
      const lines = res.data.analysis.split('\n').filter((l: string) => l.trim())
      aiInsight.value = lines.slice(0, 3).join('\n')
    }
  } catch { /* ignore */ }
  finally { aiInsightLoading.value = false }
}

function dismissAlert(index: number) { dismissedAlerts.value.add(index) }

function fmt(cents: number): string {
  return (Math.abs(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(d: string): string {
  return d.slice(5) // MM-DD
}

const trendChartData = computed(() => {
  if (!data.value) return { labels: [], datasets: [] }
  return {
    labels: data.value.trend_7days.map(d => fmtDate(d.date)),
    datasets: [{
      data: data.value.trend_7days.map(d => d.total / 100),
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
</script>

<template>
  <div class="pb-20 md:pb-4">
    <!-- Loading -->
    <div v-if="loading" class="space-y-4 animate-pulse">
      <div class="h-28 rounded-xl" style="background: var(--color-border-light)"></div>
      <div class="grid grid-cols-3 gap-3">
        <div class="h-20 rounded-xl" style="background: var(--color-border-light)"></div>
        <div class="h-20 rounded-xl" style="background: var(--color-border-light)"></div>
        <div class="h-20 rounded-xl" style="background: var(--color-border-light)"></div>
      </div>
      <div class="h-44 rounded-xl" style="background: var(--color-border-light)"></div>
    </div>

    <div v-else-if="data">
      <!-- 净资产大卡片 -->
      <div class="card mb-4" style="background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); border: none; color: white; padding: 1.25rem">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs opacity-75 mb-1">净资产</p>
            <p class="text-2xl font-bold amount-number">¥{{ fmt(data.net_worth.total) }}</p>
          </div>
          <router-link to="/assets" class="text-xs opacity-75 hover:opacity-100 transition">
            查看详情 →
          </router-link>
        </div>
        <div v-if="data.net_worth.accounts.length > 0" class="mt-3 flex flex-wrap gap-2">
          <span
            v-for="acc in data.net_worth.accounts.slice(0, 4)"
            :key="acc.id"
            class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-white/15"
          >
            <span>{{ acc.name }}</span>
            <span class="font-medium">¥{{ fmt(acc.balance) }}</span>
          </span>
        </div>
      </div>

      <!-- 月度摘要 -->
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">本月支出</p>
          <p class="text-base font-semibold amount-number amount-expense">¥{{ fmt(data.summary.expense) }}</p>
          <p v-if="data.summary.expense_change !== null" class="text-[10px] mt-0.5" style="color: var(--color-text-muted)">
            {{ data.summary.expense_change > 0 ? '↑' : '↓' }}{{ Math.abs(data.summary.expense_change) }}% 环比
          </p>
        </div>
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">本月收入</p>
          <p class="text-base font-semibold amount-number amount-income">¥{{ fmt(data.summary.income) }}</p>
          <p v-if="data.summary.income_change !== null" class="text-[10px] mt-0.5" style="color: var(--color-text-muted)">
            {{ data.summary.income_change > 0 ? '↑' : '↓' }}{{ Math.abs(data.summary.income_change) }}% 环比
          </p>
        </div>
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">结余</p>
          <p class="text-base font-semibold amount-number amount-balance">¥{{ fmt(data.summary.balance) }}</p>
          <p class="text-[10px] mt-0.5" style="color: var(--color-text-muted)">{{ data.summary.transaction_count }}笔</p>
        </div>
      </div>

      <div class="lg:grid lg:grid-cols-12 lg:gap-5">
        <!-- 左列 -->
        <div class="lg:col-span-7 space-y-4 mb-4 lg:mb-0">
          <!-- 趋势图 -->
          <div class="card">
            <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">近7日支出</h3>
            <div class="h-36">
              <Line v-if="data.trend_7days.some(d => d.total > 0)" :data="trendChartData" :options="trendChartOptions" />
              <div v-else class="flex items-center justify-center h-full text-sm" style="color: var(--color-text-muted)">暂无数据</div>
            </div>
          </div>

          <!-- 分类 TOP5 -->
          <div v-if="data.top_categories.length > 0" class="card">
            <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">支出分类</h3>
            <div class="space-y-3">
              <div v-for="cat in data.top_categories" :key="cat.name" class="flex items-center gap-3">
                <span class="text-base w-6 text-center">{{ cat.icon }}</span>
                <div class="flex-1 min-w-0">
                  <div class="flex justify-between items-center mb-1">
                    <span class="text-sm" style="color: var(--color-text-primary)">{{ cat.name }}</span>
                    <span class="text-sm font-medium amount-number" style="color: var(--color-text-secondary)">¥{{ fmt(cat.total) }}</span>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-bar-fill" style="background: var(--color-primary-500)" :style="{ width: `${cat.percent}%` }"></div>
                  </div>
                </div>
                <span class="text-[11px] w-8 text-right" style="color: var(--color-text-muted)">{{ cat.percent }}%</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右列 -->
        <div class="lg:col-span-5 space-y-4">
          <!-- 预警 -->
          <div v-if="visibleAlerts.length > 0" class="space-y-2">
            <div
              v-for="(alert, index) in data.alerts"
              :key="index"
              v-show="!dismissedAlerts.has(index)"
              class="card flex items-center gap-3 py-3"
              :style="alert.type.includes('exceeded') ? 'border-color: #fecaca; background: #fef2f2' : 'border-color: #fde68a; background: #fffbeb'"
            >
              <span class="text-sm">{{ alert.type.includes('exceeded') ? '🔴' : '🟡' }}</span>
              <span class="flex-1 text-sm" style="color: var(--color-text-primary)">{{ alert.message }}</span>
              <button @click="dismissAlert(index)" class="text-xs p-1 opacity-40 hover:opacity-100">✕</button>
            </div>
          </div>

          <!-- 预算进度 -->
          <div v-if="data.budget_progress.length > 0" class="card">
            <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">预算</h3>
            <div class="space-y-3">
              <div v-for="b in data.budget_progress" :key="b.category_name">
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm" style="color: var(--color-text-secondary)">{{ b.category_icon }} {{ b.category_name }}</span>
                  <span class="text-[11px]" style="color: var(--color-text-muted)">{{ b.percent }}%</span>
                </div>
                <div class="progress-bar">
                  <div class="progress-bar-fill"
                    :style="{
                      width: `${Math.min(b.percent, 100)}%`,
                      background: b.status === 'exceeded' ? '#dc2626' : b.status === 'warning' ? '#f59e0b' : '#059669'
                    }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 最近交易 -->
          <div class="card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">最近交易</h3>
              <router-link to="/ledger" class="text-[11px]" style="color: var(--color-primary-600)">全部 →</router-link>
            </div>
            <div v-if="data.recent_transactions.length > 0" class="space-y-2.5">
              <div v-for="tx in data.recent_transactions" :key="tx.id" class="flex items-center gap-3">
                <span class="text-base w-6 text-center">{{ tx.category_icon }}</span>
                <div class="flex-1 min-w-0">
                  <p class="text-sm truncate" style="color: var(--color-text-primary)">{{ tx.description }}</p>
                  <p class="text-[11px]" style="color: var(--color-text-muted)">{{ tx.account_name }} · {{ fmtDate(tx.date) }}</p>
                </div>
                <span class="text-sm font-medium amount-number" :class="tx.type === 'expense' ? 'amount-expense' : 'amount-income'">
                  {{ tx.type === 'expense' ? '-' : '+' }}¥{{ fmt(tx.amount) }}
                </span>
              </div>
            </div>
            <div v-else class="text-center py-6 text-sm" style="color: var(--color-text-muted)">暂无记录</div>
          </div>

          <!-- AI 洞察 -->
          <div class="card" style="border-top: 3px solid var(--color-primary-400)">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">AI 洞察</h3>
              <button
                @click="fetchAiInsight"
                :disabled="aiInsightLoading"
                class="btn-secondary text-[11px] !py-1 !px-2"
              >
                {{ aiInsightLoading ? '分析中...' : aiInsight ? '刷新' : '生成' }}
              </button>
            </div>
            <div v-if="aiInsight" class="text-sm leading-relaxed whitespace-pre-line" style="color: var(--color-text-secondary)">{{ aiInsight }}</div>
            <div v-else-if="aiInsightLoading" class="flex items-center gap-2 py-2">
              <span class="w-4 h-4 border-2 rounded-full animate-spin" style="border-color: var(--color-primary-200); border-top-color: var(--color-primary-600)"></span>
              <span class="text-xs" style="color: var(--color-text-muted)">AI 正在分析...</span>
            </div>
            <div v-else class="text-xs py-1" style="color: var(--color-text-muted)">点击"生成"获取财务洞察</div>
          </div>

          <!-- 快捷入口 -->
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
        </div>
      </div>
    </div>
  </div>
</template>
