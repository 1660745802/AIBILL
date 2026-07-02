<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import ConfirmCards from '@/components/ConfirmCards.vue'
import ManualForm from '@/components/ManualForm.vue'
import TodayList from '@/components/TodayList.vue'

// 状态
const input = ref('')
const loading = ref(false)
const confirming = ref(false)
const error = ref('')
const parsedItems = ref<any[]>([])
const showManual = ref(false)
const summary = ref({ expense: 0, income: 0 })
const todayTransactions = ref<any[]>([])

// 预算警告
interface BudgetWarning {
  category_name: string
  status: 'warning' | 'exceeded'
  percent: number
  spent: number
  amount: number
}
const budgetWarnings = ref<BudgetWarning[]>([])
const showBudgetWarning = ref(false)
// 本月摘要
const balance = computed(() => summary.value.income - summary.value.expense)

onMounted(() => {
  fetchSummary()
  fetchToday()
})

async function fetchSummary() {
  try {
    const { data } = await api.get('/stats/summary')
    if (data.code === 0) {
      summary.value = { expense: data.data.expense, income: data.data.income }
    }
  } catch { /* ignore */ }
}

async function fetchToday() {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const { data } = await api.get('/transactions', {
      params: { start_date: today, end_date: today, page_size: 50 },
    })
    if (data.code === 0) {
      todayTransactions.value = data.data.items
    }
  } catch { /* ignore */ }
}

async function handleAiParse() {
  if (!input.value.trim()) return
  error.value = ''
  loading.value = true
  parsedItems.value = []

  try {
    const { data } = await api.post('/ai/parse', { input: input.value })
    if (data.code === 0 && data.data.items.length > 0) {
      parsedItems.value = data.data.items
    } else {
      // AI 失败，切手动
      error.value = data.message || 'AI 无法解析'
      showManual.value = true
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || 'AI 请求失败'
    showManual.value = true
  } finally {
    loading.value = false
  }
}

async function handleConfirm(items: any[]) {
  if (confirming.value) return
  confirming.value = true
  try {
    const payload = items.map((item) => ({
      client_id: crypto.randomUUID(),
      client_type: 'web',
      source: 'ai',
      source_detail: input.value,
      type: item.type,
      amount: item.amount,
      category_id: item.category_id,
      account_id: item.account_id || undefined,
      target_account_id: item.target_account_id || undefined,
      description: item.description,
      date: item.date,
      ai_raw_input: input.value,
    }))

    await api.post('/transactions', { items: payload })
    // 重置状态
    parsedItems.value = []
    input.value = ''
    fetchSummary()
    fetchToday()
    await checkBudgetWarnings()
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  } finally {
    confirming.value = false
  }
}

function handleCancel() {
  parsedItems.value = []
}

async function handleManualSubmit(item: any) {
  try {
    const payload = [{
      client_id: crypto.randomUUID(),
      client_type: 'web',
      source: 'manual',
      type: item.type,
      amount: item.amount,
      category_id: item.category_id,
      account_id: item.account_id || undefined,
      target_account_id: item.target_account_id || undefined,
      description: item.description,
      date: item.date,
    }]

    await api.post('/transactions', { items: payload })
    showManual.value = false
    input.value = ''
    fetchSummary()
    fetchToday()
    await checkBudgetWarnings()
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  }
}

async function checkBudgetWarnings() {
  try {
    const { data } = await api.get('/budgets')
    if (data.code === 0) {
      const warnings: BudgetWarning[] = []
      for (const b of data.data.items) {
        if (b.status === 'warning' || b.status === 'exceeded') {
          warnings.push({
            category_name: b.category_name,
            status: b.status,
            percent: b.percent,
            spent: b.spent,
            amount: b.amount,
          })
        }
      }
      if (warnings.length > 0) {
        budgetWarnings.value = warnings
        showBudgetWarning.value = true
      }
    }
  } catch { /* ignore */ }
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <div class="pb-4">
    <!-- 预算超支提醒 -->
    <div v-if="showBudgetWarning && budgetWarnings.length > 0" class="mb-2">
      <div
        v-for="(w, idx) in budgetWarnings"
        :key="idx"
        class="px-4 py-2.5 text-sm flex items-center justify-between"
        :class="w.status === 'exceeded' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'"
      >
        <span v-if="w.status === 'warning'">
          ⚠️ 本月{{ w.category_name }}预算已用{{ w.percent }}%，接近上限
        </span>
        <span v-else>
          🚨 本月{{ w.category_name }}已超支，超出¥{{ formatAmount(w.spent - w.amount) }}
        </span>
        <button
          @click="budgetWarnings.splice(idx, 1); if (budgetWarnings.length === 0) showBudgetWarning = false"
          class="ml-2 text-current opacity-60 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 本月摘要 -->
    <div class="bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-4 mb-2 rounded-lg mx-2">
      <div class="grid grid-cols-3 gap-4 text-center">
        <div>
          <div class="text-xs text-blue-100">本月支出</div>
          <div class="text-lg font-semibold text-white">¥{{ formatAmount(summary.expense) }}</div>
        </div>
        <div>
          <div class="text-xs text-blue-100">本月收入</div>
          <div class="text-lg font-semibold text-white">¥{{ formatAmount(summary.income) }}</div>
        </div>
        <div>
          <div class="text-xs text-blue-100">结余</div>
          <div class="text-lg font-semibold text-white">
            ¥{{ formatAmount(balance) }}
          </div>
        </div>
      </div>
    </div>

    <!-- AI 输入区 -->
    <div class="bg-white px-4 py-4 mb-2">
      <form @submit.prevent="handleAiParse" class="flex gap-2">
        <input
          v-model="input"
          type="text"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          placeholder="说点什么就能记账... 如：午饭32，打车15"
          :disabled="loading"
        />
        <button
          type="submit"
          :disabled="loading || !input.trim()"
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          {{ loading ? '...' : '记账' }}
        </button>
        <button
          type="button"
          @click="showManual = true"
          class="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
        >
          手动
        </button>
      </form>

      <div v-if="error" class="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
        {{ error }}
      </div>
    </div>

    <!-- 确认卡片 -->
    <ConfirmCards
      v-if="parsedItems.length > 0"
      :items="parsedItems"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />

    <!-- 手动记账表单 -->
    <ManualForm
      v-if="showManual"
      :initial-description="input"
      @submit="handleManualSubmit"
      @cancel="showManual = false"
    />

    <!-- 今日流水 -->
    <TodayList :transactions="todayTransactions" @refresh="fetchToday" />
  </div>
</template>
