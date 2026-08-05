<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { Line, Doughnut } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import api from '@/api/index'
import Skeleton from '@/components/Skeleton.vue'
import EmptyState from '@/components/EmptyState.vue'
import EditTransactionModal from '@/components/EditTransactionModal.vue'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Title, Tooltip, Legend, Filler)

// Tab state
const activeTab = ref<'transactions' | 'stats'>('transactions')

// Shared month selector
const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)

function prevMonth() {
  if (month.value === 1) { year.value--; month.value = 12 }
  else month.value--
}
function nextMonth() {
  if (month.value === 12) { year.value++; month.value = 1 }
  else month.value++
}

// ==================== Tab 1: Transactions ====================
interface Transaction {
  id: number
  type: string
  amount: number
  description: string
  date: string
  category_id: number | null
  account_id: number | null
  target_account_id: number | null
  category_name: string
  category_icon: string
  account_name: string
  target_account_name?: string
  tags?: string
}

const transactions = ref<Transaction[]>([])
const txLoading = ref(false)
const txTotal = ref(0)
const txPage = ref(1)
const txPageSize = 20
const txHasMore = computed(() => txPage.value * txPageSize < txTotal.value)

const keyword = ref('')
const filterType = ref('')

const showEditModal = ref(false)
const editingTransaction = ref<Transaction | null>(null)

async function fetchTransactions(append = false) {
  txLoading.value = true
  try {
    const startDate = `${year.value}-${String(month.value).padStart(2, '0')}-01`
    const endDay = new Date(year.value, month.value, 0).getDate()
    const endDate = `${year.value}-${String(month.value).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`

    const params: Record<string, any> = {
      page: txPage.value,
      page_size: txPageSize,
      start_date: startDate,
      end_date: endDate,
    }
    if (keyword.value) params.keyword = keyword.value
    if (filterType.value) params.type = filterType.value

    const { data } = await api.get('/transactions', { params })
    if (data.code === 0) {
      if (append) {
        transactions.value = [...transactions.value, ...data.data.items]
      } else {
        transactions.value = data.data.items
      }
      txTotal.value = data.data.total
    }
  } catch { /* ignore */ }
  finally { txLoading.value = false }
}

function handleSearch() {
  txPage.value = 1
  fetchTransactions()
}

function handleFilterType(type: string) {
  filterType.value = type
  txPage.value = 1
  fetchTransactions()
}

function loadMore() {
  txPage.value++
  fetchTransactions(true)
}

function handleRowClick(tx: Transaction) {
  editingTransaction.value = tx
  showEditModal.value = true
}

function handleEditSaved() {
  showEditModal.value = false
  editingTransaction.value = null
  txPage.value = 1
  fetchTransactions()
}

const groupedTransactions = computed(() => {
  const groups: Record<string, Transaction[]> = {}
  for (const tx of transactions.value) {
    if (!groups[tx.date]) groups[tx.date] = []
    groups[tx.date]!.push(tx)
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
})

function getDailyExpense(items: Transaction[]): number {
  let total = 0
  for (const tx of items) {
    if (tx.type === 'expense') total += tx.amount
  }
  return total
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekDays[d.getDay()]}`
}

// ==================== Tab 2: Stats ====================
const summary = ref<any>(null)
const categoryData = ref<any[]>([])
const trendData = ref<any[]>([])
const viewType = ref<'expense' | 'income'>('expense')

async function fetchSummary() {
  try {
    const { data } = await api.get('/stats/summary', { params: { year: year.value, month: month.value } })
    if (data.code === 0) summary.value = data.data
  } catch { /* ignore */ }
}

async function fetchCategory() {
  try {
    const { data } = await api.get('/stats/by-category', { params: { year: year.value, month: month.value, type: viewType.value } })
    if (data.code === 0) {
      categoryData.value = data.data.items
    }
  } catch { /* ignore */ }
}

async function fetchTrend() {
  try {
    const { data } = await api.get('/stats/trend', { params: { year: year.value, month: month.value, period: 'daily', type: viewType.value } })
    if (data.code === 0) trendData.value = data.data.items
  } catch { /* ignore */ }
}

async function fetchStats() {
  await Promise.all([fetchSummary(), fetchCategory(), fetchTrend()])
}

// AI Analysis
const aiSummary = ref('')
const aiFullText = ref('')
const aiLoading = ref(false)
const aiExpanded = ref(false)
const aiGenerated = ref(false)

async function generateAiSummary() {
  aiLoading.value = true
  aiGenerated.value = false
  try {
    const { data } = await api.post('/stats/analysis', {
      type: 'spending',
      year: year.value,
      month: month.value,
    })
    if (data.code === 0) {
      const text = data.data.analysis || data.data.content || ''
      // First line as summary, rest as full text
      const lines = text.split('\n').filter((l: string) => l.trim())
      aiSummary.value = lines[0] || '暂无分析结果'
      aiFullText.value = text
      aiGenerated.value = true
    }
  } catch { /* ignore */ }
  finally { aiLoading.value = false }
}

// Chart computed data
const trendChartData = computed(() => ({
  labels: trendData.value.map((d) => d.date.slice(8)),
  datasets: [{
    label: viewType.value === 'expense' ? '支出' : '收入',
    data: trendData.value.map((d) => d.total / 100),
    borderColor: viewType.value === 'expense' ? '#ef4444' : '#22c55e',
    backgroundColor: viewType.value === 'expense' ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
    fill: true,
    tension: 0.4,
    pointRadius: 2,
    pointHoverRadius: 5,
  }],
}))

const trendChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    y: { beginAtZero: true, ticks: { callback: (v: any) => `¥${v}` }, grid: { color: 'rgba(0,0,0,0.04)' } },
    x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
  },
}

const doughnutChartData = computed(() => ({
  labels: categoryData.value.map((c) => c.name),
  datasets: [{
    data: categoryData.value.map((c) => c.total / 100),
    backgroundColor: [
      '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
      '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280', '#14b8a6',
      '#f59e0b', '#a855f7',
    ],
    borderWidth: 0,
  }],
}))

const doughnutChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: 'right' as const, labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } } },
  cutout: '60%',
}

// Watchers
watch([year, month], () => {
  txPage.value = 1
  if (activeTab.value === 'transactions') {
    fetchTransactions()
  } else {
    fetchStats()
  }
  // Reset AI state on month change
  aiGenerated.value = false
  aiSummary.value = ''
  aiFullText.value = ''
  aiExpanded.value = false
})

watch(viewType, () => {
  fetchCategory()
  fetchTrend()
})

watch(activeTab, (tab) => {
  if (tab === 'transactions' && transactions.value.length === 0) {
    fetchTransactions()
  } else if (tab === 'stats' && !summary.value) {
    fetchStats()
  }
})

onMounted(() => {
  fetchTransactions()
})
</script>

<template>
  <div class="pb-4">
    <!-- Month Selector -->
    <div class="bg-white px-4 py-3 flex items-center justify-between">
      <button @click="prevMonth" class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">◀</button>
      <span class="text-sm font-semibold text-gray-800">{{ year }}年{{ month }}月</span>
      <button @click="nextMonth" class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">▶</button>
    </div>

    <!-- Tab Bar -->
    <div class="bg-white px-4 pt-1 pb-3">
      <div class="flex bg-gray-100 rounded-xl p-1">
        <button
          @click="activeTab = 'transactions'"
          class="flex-1 py-2 text-sm font-medium rounded-lg transition-all"
          :class="activeTab === 'transactions' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
        >
          流水
        </button>
        <button
          @click="activeTab = 'stats'"
          class="flex-1 py-2 text-sm font-medium rounded-lg transition-all"
          :class="activeTab === 'stats' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
        >
          图表
        </button>
      </div>
    </div>

    <!-- Tab 1: Transactions -->
    <div v-if="activeTab === 'transactions'">
      <!-- Filters -->
      <div class="bg-white px-4 py-3 mb-2 space-y-3">
        <!-- Type filter pills -->
        <div class="flex gap-2">
          <button
            v-for="opt in [{ label: '全部', value: '' }, { label: '支出', value: 'expense' }, { label: '收入', value: 'income' }]"
            :key="opt.value"
            @click="handleFilterType(opt.value)"
            class="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
            :class="filterType === opt.value ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
          >
            {{ opt.label }}
          </button>
        </div>
        <!-- Search -->
        <div class="flex gap-2">
          <input
            v-model="keyword"
            type="text"
            class="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="搜索描述..."
            @keyup.enter="handleSearch"
          />
          <button
            @click="handleSearch"
            class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
          >
            搜索
          </button>
        </div>
      </div>

      <!-- Transaction List -->
      <div v-if="txLoading && transactions.length === 0" class="bg-white">
        <Skeleton :lines="5" />
      </div>

      <div v-else-if="transactions.length === 0" class="bg-white">
        <EmptyState icon="📄" title="暂无交易记录" description="该月还没有记录" />
      </div>

      <div v-else>
        <div v-for="[date, items] in groupedTransactions" :key="date" class="mb-2">
          <div class="px-4 py-2 text-xs bg-gray-50 flex items-center justify-between">
            <span class="text-gray-500">{{ formatDate(date) }}</span>
            <span class="text-red-500">-¥{{ formatAmount(getDailyExpense(items)) }}</span>
          </div>
          <div class="bg-white">
            <div
              v-for="tx in items"
              :key="tx.id"
              @click="handleRowClick(tx)"
              class="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 transition-colors"
            >
              <div class="flex items-center gap-2.5 flex-1 min-w-0">
                <span class="text-lg">{{ tx.category_icon || '📦' }}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-800 truncate">{{ tx.description || tx.category_name || '未分类' }}</div>
                  <div class="text-xs text-gray-400 mt-0.5">{{ tx.category_name || '' }}<span v-if="tx.account_name"> · {{ tx.account_name }}</span></div>
                </div>
                <!-- PC only extra info -->
                <span v-if="tx.tags" class="hidden md:inline text-[11px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{{ tx.tags }}</span>
                <span class="hidden md:inline text-[11px] text-gray-300">{{ tx.date.slice(11, 16) }}</span>
              </div>
              <span
                class="text-sm font-medium ml-3 shrink-0"
                :class="{
                  'text-red-500': tx.type === 'expense',
                  'text-green-500': tx.type === 'income',
                  'text-blue-500': tx.type === 'transfer',
                }"
              >
                {{ tx.type === 'income' ? '+' : '-' }}¥{{ formatAmount(tx.amount) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Load more -->
        <div v-if="txHasMore" class="px-4 py-4">
          <button
            @click="loadMore"
            :disabled="txLoading"
            class="w-full py-2.5 text-sm text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {{ txLoading ? '加载中...' : '加载更多' }}
          </button>
        </div>
        <div v-else class="text-center py-4 text-xs text-gray-400">已显示全部</div>
      </div>
    </div>

    <!-- Tab 2: Stats -->
    <div v-if="activeTab === 'stats'">
      <!-- Summary Card -->
      <div v-if="summary" class="mx-3 mb-3 p-4 bg-white rounded-xl shadow-sm">
        <div class="grid grid-cols-3 gap-3 text-center">
          <div>
            <div class="text-xs text-gray-500">支出</div>
            <div class="text-base font-bold text-red-500 mt-0.5">¥{{ formatAmount(summary.expense) }}</div>
            <div v-if="summary.expense_change !== null" class="text-[10px] mt-0.5" :class="summary.expense_change > 0 ? 'text-red-400' : 'text-green-400'">
              {{ summary.expense_change > 0 ? '↑' : '↓' }}{{ Math.abs(summary.expense_change) }}%
            </div>
          </div>
          <div>
            <div class="text-xs text-gray-500">收入</div>
            <div class="text-base font-bold text-green-500 mt-0.5">¥{{ formatAmount(summary.income) }}</div>
            <div v-if="summary.income_change !== null" class="text-[10px] mt-0.5" :class="summary.income_change > 0 ? 'text-green-400' : 'text-red-400'">
              {{ summary.income_change > 0 ? '↑' : '↓' }}{{ Math.abs(summary.income_change) }}%
            </div>
          </div>
          <div>
            <div class="text-xs text-gray-500">结余</div>
            <div class="text-base font-bold mt-0.5" :class="summary.balance >= 0 ? 'text-gray-700' : 'text-red-500'">
              ¥{{ formatAmount(summary.balance) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Expense/Income Toggle -->
      <div class="mx-3 mb-3 flex gap-2">
        <button
          @click="viewType = 'expense'"
          class="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
          :class="viewType === 'expense' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        >
          支出
        </button>
        <button
          @click="viewType = 'income'"
          class="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
          :class="viewType === 'income' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        >
          收入
        </button>
      </div>

      <!-- Trend Line Chart -->
      <div class="mx-3 mb-3 bg-white p-4 rounded-xl shadow-sm">
        <h3 class="text-sm font-medium text-gray-700 mb-3">{{ viewType === 'expense' ? '支出' : '收入' }}趋势</h3>
        <div class="h-44">
          <Line v-if="trendData.length > 0" :data="trendChartData" :options="trendChartOptions" />
          <div v-else class="flex items-center justify-center h-full text-sm text-gray-400">暂无数据</div>
        </div>
      </div>

      <!-- Category Doughnut Chart -->
      <div class="mx-3 mb-3 bg-white p-4 rounded-xl shadow-sm">
        <h3 class="text-sm font-medium text-gray-700 mb-3">{{ viewType === 'expense' ? '支出' : '收入' }}分类</h3>
        <div v-if="categoryData.length > 0" class="h-48">
          <Doughnut :data="doughnutChartData" :options="doughnutChartOptions" />
        </div>
        <div v-else class="text-center py-8 text-sm text-gray-400">暂无数据</div>
      </div>

      <!-- Category Ranking -->
      <div class="mx-3 mb-3 bg-white p-4 rounded-xl shadow-sm">
        <h3 class="text-sm font-medium text-gray-700 mb-3">{{ viewType === 'expense' ? '消费' : '收入' }}排行</h3>
        <div v-if="categoryData.length === 0" class="text-center py-4 text-sm text-gray-400">暂无数据</div>
        <div v-else class="space-y-2.5">
          <div v-for="(cat, index) in categoryData" :key="cat.id" class="flex items-center gap-3">
            <span class="text-xs text-gray-400 w-4 text-center">{{ index + 1 }}</span>
            <span class="text-base">{{ cat.icon }}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-800">{{ cat.name }}</span>
                <span class="text-sm font-medium text-gray-700">¥{{ formatAmount(cat.total) }}</span>
              </div>
              <div class="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full rounded-full transition-all" :class="viewType === 'expense' ? 'bg-red-400' : 'bg-green-400'" :style="{ width: `${cat.percent}%` }"></div>
              </div>
            </div>
            <span class="text-xs text-gray-400 w-10 text-right">{{ cat.percent }}%</span>
          </div>
        </div>
      </div>

      <!-- AI Summary Card -->
      <div class="mx-3 mb-3 p-[2px] rounded-xl bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400">
        <div class="bg-white p-4 rounded-[10px]">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-base">🤖</span>
            <h3 class="text-sm font-medium text-gray-700">AI 总结</h3>
          </div>

          <div v-if="!aiGenerated && !aiLoading">
            <p class="text-xs text-gray-400 mb-3">让 AI 分析你本月的消费情况</p>
            <button
              @click="generateAiSummary"
              class="w-full py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-500 to-blue-500 rounded-lg hover:from-purple-600 hover:to-blue-600 transition-all"
            >
              生成 AI 总结
            </button>
          </div>

          <div v-else-if="aiLoading" class="flex items-center justify-center py-4">
            <div class="w-5 h-5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin"></div>
            <span class="ml-2 text-xs text-gray-400">AI 分析中...</span>
          </div>

          <div v-else>
            <p class="text-sm text-gray-700 leading-relaxed">{{ aiSummary }}</p>
            <div v-if="aiExpanded" class="mt-3 pt-3 border-t border-gray-100">
              <p class="text-xs text-gray-600 leading-relaxed whitespace-pre-line">{{ aiFullText }}</p>
            </div>
            <button
              @click="aiExpanded = !aiExpanded"
              class="mt-2 text-xs text-purple-500 hover:text-purple-700 font-medium transition-colors"
            >
              {{ aiExpanded ? '收起' : '查看详细分析' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Edit Modal -->
  <EditTransactionModal
    :show="showEditModal"
    :transaction="editingTransaction"
    @close="showEditModal = false"
    @saved="handleEditSaved"
  />
</template>
