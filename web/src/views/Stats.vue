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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Title, Tooltip, Legend, Filler)

const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)

const summary = ref<any>(null)
const categoryData = ref<any[]>([])
const trendData = ref<any[]>([])
const categoryTotal = ref(0)

onMounted(() => fetchAll())
watch([year, month], () => fetchAll())

async function fetchAll() {
  await Promise.all([fetchSummary(), fetchCategory(), fetchTrend()])
}

async function fetchSummary() {
  try {
    const { data } = await api.get('/stats/summary', { params: { year: year.value, month: month.value } })
    if (data.code === 0) summary.value = data.data
  } catch { /* ignore */ }
}

async function fetchCategory() {
  try {
    const { data } = await api.get('/stats/by-category', { params: { year: year.value, month: month.value, type: 'expense' } })
    if (data.code === 0) {
      categoryData.value = data.data.items
      categoryTotal.value = data.data.total
    }
  } catch { /* ignore */ }
}

async function fetchTrend() {
  try {
    const { data } = await api.get('/stats/trend', { params: { year: year.value, month: month.value, period: 'daily', type: 'expense' } })
    if (data.code === 0) trendData.value = data.data.items
  } catch { /* ignore */ }
}

function prevMonth() {
  if (month.value === 1) { year.value--; month.value = 12 }
  else month.value--
}
function nextMonth() {
  if (month.value === 12) { year.value++; month.value = 1 }
  else month.value++
}

// 趋势图数据
const trendChartData = computed(() => ({
  labels: trendData.value.map((d) => d.date.slice(8)),
  datasets: [{
    label: '支出',
    data: trendData.value.map((d) => d.total / 100),
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239,68,68,0.1)',
    fill: true,
    tension: 0.3,
    pointRadius: 2,
  }],
}))

const trendChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    y: { beginAtZero: true, ticks: { callback: (v: any) => `¥${v}` } },
    x: { ticks: { maxTicksLimit: 10 } },
  },
}

// 饼图数据
const pieChartData = computed(() => ({
  labels: categoryData.value.map((c) => c.name),
  datasets: [{
    data: categoryData.value.map((c) => c.total / 100),
    backgroundColor: [
      '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
      '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280', '#14b8a6',
      '#f59e0b', '#a855f7',
    ],
  }],
}))

const pieChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: 'right' as const, labels: { boxWidth: 12, font: { size: 11 } } } },
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <div class="pb-4">
    <!-- 月份切换 -->
    <div class="bg-white px-4 py-3 flex items-center justify-between mb-2">
      <button @click="prevMonth" class="px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded">◀</button>
      <span class="text-sm font-medium text-gray-800">{{ year }}年{{ month }}月</span>
      <button @click="nextMonth" class="px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded">▶</button>
    </div>

    <!-- 收支摘要 -->
    <div v-if="summary" class="bg-white px-4 py-4 mb-2">
      <div class="grid grid-cols-3 gap-4 text-center">
        <div>
          <div class="text-xs text-gray-500">支出</div>
          <div class="text-lg font-semibold text-red-500">¥{{ formatAmount(summary.expense) }}</div>
          <div v-if="summary.expense_change !== null" class="text-xs" :class="summary.expense_change > 0 ? 'text-red-400' : 'text-green-400'">
            {{ summary.expense_change > 0 ? '↑' : '↓' }}{{ Math.abs(summary.expense_change) }}%
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500">收入</div>
          <div class="text-lg font-semibold text-green-500">¥{{ formatAmount(summary.income) }}</div>
          <div v-if="summary.income_change !== null" class="text-xs" :class="summary.income_change > 0 ? 'text-green-400' : 'text-red-400'">
            {{ summary.income_change > 0 ? '↑' : '↓' }}{{ Math.abs(summary.income_change) }}%
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500">结余</div>
          <div class="text-lg font-semibold" :class="summary.balance >= 0 ? 'text-gray-700' : 'text-red-500'">
            ¥{{ formatAmount(summary.balance) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 趋势图 -->
    <div class="bg-white px-4 py-4 mb-2">
      <h3 class="text-sm font-medium text-gray-700 mb-3">支出趋势</h3>
      <div class="h-48">
        <Line v-if="trendData.length > 0" :data="trendChartData" :options="trendChartOptions" />
        <div v-else class="flex items-center justify-center h-full text-sm text-gray-400">暂无数据</div>
      </div>
    </div>

    <!-- 分类饼图 -->
    <div class="bg-white px-4 py-4 mb-2">
      <h3 class="text-sm font-medium text-gray-700 mb-3">分类占比</h3>
      <div v-if="categoryData.length > 0" class="h-48">
        <Doughnut :data="pieChartData" :options="pieChartOptions" />
      </div>
      <div v-else class="text-center py-8 text-sm text-gray-400">暂无数据</div>
    </div>

    <!-- 分类排行 -->
    <div class="bg-white px-4 py-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">消费排行</h3>
      <div v-if="categoryData.length === 0" class="text-center py-4 text-sm text-gray-400">暂无数据</div>
      <div v-else class="space-y-2">
        <div v-for="(cat, index) in categoryData" :key="cat.id" class="flex items-center gap-3">
          <span class="text-xs text-gray-400 w-4">{{ index + 1 }}</span>
          <span class="text-base">{{ cat.icon }}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="text-sm text-gray-800">{{ cat.name }}</span>
              <span class="text-sm font-medium text-gray-700">¥{{ formatAmount(cat.total) }}</span>
            </div>
            <div class="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div class="h-full bg-blue-500 rounded-full" :style="{ width: `${cat.percent}%` }"></div>
            </div>
          </div>
          <span class="text-xs text-gray-400 w-10 text-right">{{ cat.percent }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>
