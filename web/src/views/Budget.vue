<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'

interface BudgetItem {
  id: number
  category_id: number | null
  category_name: string
  category_icon: string
  amount: number
  spent: number
  percent: number
  status: string
  remaining: number
}

interface Category {
  id: number
  name: string
  icon: string
}

const budgets = ref<BudgetItem[]>([])
const categories = ref<Category[]>([])
const loading = ref(false)
const error = ref('')

// 月份切换
const currentYear = ref(new Date().getFullYear())
const currentMonth = ref(new Date().getMonth() + 1)

const displayMonth = computed(() => {
  return `${currentYear.value}年${currentMonth.value}月`
})

// 添加预算表单
const formCategoryId = ref<number | null>(null) // null 代表总预算
const formAmount = ref('')
const saving = ref(false)

function prevMonth() {
  if (currentMonth.value === 1) {
    currentMonth.value = 12
    currentYear.value--
  } else {
    currentMonth.value--
  }
  fetchBudgets()
}

function nextMonth() {
  if (currentMonth.value === 12) {
    currentMonth.value = 1
    currentYear.value++
  } else {
    currentMonth.value++
  }
  fetchBudgets()
}

async function fetchBudgets() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/budgets', {
      params: { year: currentYear.value, month: currentMonth.value },
    })
    if (data.code === 0) {
      budgets.value = data.data.items || []
    } else {
      error.value = data.message || '获取预算失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '获取预算失败'
  } finally {
    loading.value = false
  }
}

async function fetchCategories() {
  try {
    const { data } = await api.get('/categories')
    if (data.code === 0) {
      categories.value = data.data || []
    }
  } catch { /* ignore */ }
}

async function handleAddBudget() {
  const amountNum = parseFloat(formAmount.value)
  if (isNaN(amountNum) || amountNum <= 0) {
    error.value = '请输入有效金额'
    return
  }

  saving.value = true
  error.value = ''
  try {
    const payload = {
      category_id: formCategoryId.value,
      amount: Math.round(amountNum * 100), // 转换为分
      period: 'monthly',
      year: currentYear.value,
      month: currentMonth.value,
    }
    const { data } = await api.post('/budgets', payload)
    if (data.code === 0) {
      formAmount.value = ''
      formCategoryId.value = null
      fetchBudgets()
    } else {
      error.value = data.message || '保存失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function handleDelete(id: number) {
  if (!confirm('确定删除该预算？')) return
  try {
    const { data } = await api.delete(`/budgets/${id}`)
    if (data.code === 0) {
      fetchBudgets()
    } else {
      error.value = data.message || '删除失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '删除失败'
  }
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function getProgressColor(percent: number): string {
  if (percent > 100) return 'bg-red-500'
  if (percent >= 80) return 'bg-yellow-500'
  return 'bg-blue-500'
}

function getPercentTextColor(percent: number): string {
  if (percent > 100) return 'text-red-600'
  if (percent >= 80) return 'text-yellow-600'
  return 'text-blue-600'
}

onMounted(() => {
  fetchBudgets()
  fetchCategories()
})
</script>

<template>
  <div class="pb-4">
    <!-- 月份切换 -->
    <div class="bg-white px-4 py-3 mb-2 flex items-center justify-between">
      <button
        @click="prevMonth"
        class="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <h2 class="text-lg font-semibold text-gray-800">{{ displayMonth }}</h2>
      <button
        @click="nextMonth"
        class="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="mx-4 mb-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
      {{ error }}
    </div>

    <!-- 添加预算表单 -->
    <div class="bg-white px-4 py-4 mb-2">
      <h3 class="text-sm font-medium text-gray-700 mb-3">添加预算</h3>
      <form @submit.prevent="handleAddBudget" class="flex gap-2 items-end">
        <div class="flex-1">
          <select
            v-model="formCategoryId"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option :value="null">总预算</option>
            <option v-for="cat in categories" :key="cat.id" :value="cat.id">
              {{ cat.icon }} {{ cat.name }}
            </option>
          </select>
        </div>
        <div class="flex-1">
          <input
            v-model="formAmount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="预算金额（元）"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          :disabled="saving || !formAmount"
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </form>
    </div>

    <!-- 预算列表 -->
    <div class="bg-white px-4 py-4">
      <h3 class="text-sm font-medium text-gray-700 mb-3">预算列表</h3>

      <div v-if="loading" class="text-center py-8 text-gray-400 text-sm">加载中...</div>

      <div v-else-if="budgets.length === 0" class="text-center py-8 text-gray-400 text-sm">
        暂无预算，请添加
      </div>

      <div v-else class="space-y-4">
        <div
          v-for="item in budgets"
          :key="item.id"
          class="border border-gray-100 rounded-lg p-3"
        >
          <!-- 顶部：分类名 + 删除按钮 -->
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <span class="text-lg">{{ item.category_icon || '💰' }}</span>
              <span class="text-sm font-medium text-gray-800">{{ item.category_name || '总预算' }}</span>
            </div>
            <button
              @click="handleDelete(item.id)"
              class="text-gray-400 hover:text-red-500 p-1"
              title="删除预算"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <!-- 金额信息 -->
          <div class="flex justify-between text-xs text-gray-500 mb-1">
            <span>已花费 ¥{{ formatAmount(item.spent) }}</span>
            <span>预算 ¥{{ formatAmount(item.amount) }}</span>
          </div>

          <!-- 进度条 -->
          <div class="w-full bg-gray-200 rounded-full h-2 mb-1">
            <div
              :class="[getProgressColor(item.percent), 'h-2 rounded-full transition-all']"
              :style="{ width: Math.min(item.percent, 100) + '%' }"
            ></div>
          </div>

          <!-- 百分比 + 剩余 -->
          <div class="flex justify-between text-xs">
            <span :class="getPercentTextColor(item.percent)" class="font-medium">
              {{ item.percent }}%
            </span>
            <span :class="item.remaining >= 0 ? 'text-gray-500' : 'text-red-500'">
              {{ item.remaining >= 0 ? `剩余 ¥${formatAmount(item.remaining)}` : `超支 ¥${formatAmount(-item.remaining)}` }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
