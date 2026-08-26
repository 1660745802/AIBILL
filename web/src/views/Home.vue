<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { generateUUID } from '@/utils/uuid'
import ConfirmCards from '@/components/ConfirmCards.vue'
import ManualForm from '@/components/ManualForm.vue'
import TodayList from '@/components/TodayList.vue'

const toast = useToast()

// 状态
const input = ref('')
const loading = ref(false)
const confirming = ref(false)
const error = ref('')
const parsedItems = ref<any[]>([])
const originalParsedItems = ref<any[]>([]) // AI 原始解析结果（用于对比修正）
const parseLogId = ref<number | null>(null) // 解析日志 ID
const showManual = ref(false)
const summary = ref({ expense: 0, income: 0 })
const todayTransactions = ref<any[]>([])

// 快捷短语
const quickPhrases = ['午饭', '晚饭', '早餐', '打车', '咖啡', '地铁']

function appendPhrase(phrase: string) {
  if (input.value.trim()) {
    input.value += `，${phrase}`
  } else {
    input.value = phrase
  }
}

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
  parseLogId.value = null
  originalParsedItems.value = []

  try {
    const { data } = await api.post('/ai/parse', { input: input.value }, { timeout: 90000 })
    if (data.code === 0 && data.data.items.length > 0) {
      parsedItems.value = data.data.items
      originalParsedItems.value = JSON.parse(JSON.stringify(data.data.items))
      parseLogId.value = data.data.parse_log_id || null
    } else {
      // AI 失败，切手动
      error.value = data.message || 'AI 无法解析'
      showManual.value = true
      toast.warning('已切换到手动模式')
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || 'AI 请求失败'
    showManual.value = true
    toast.warning('已切换到手动模式')
  } finally {
    loading.value = false
  }
}

async function handleConfirm(items: any[]) {
  if (confirming.value) return
  confirming.value = true
  try {
    const payload = items.map((item) => ({
      client_id: generateUUID(),
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

    // 发送 AI 解析反馈（异步，不阻塞主流程）
    if (parseLogId.value) {
      const modified = JSON.stringify(items) !== JSON.stringify(originalParsedItems.value)
      api.post('/ai/parse-feedback', {
        parse_log_id: parseLogId.value,
        final_items: items,
        modified,
      }).catch(() => { /* 反馈失败不影响用户 */ })
    }

    // 重置状态
    parsedItems.value = []
    originalParsedItems.value = []
    parseLogId.value = null
    input.value = ''
    toast.success(`已记 ${items.length} 笔`)
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
  originalParsedItems.value = []
  parseLogId.value = null
}

async function handleManualSubmit(item: any) {
  try {
    const payload = [{
      client_id: generateUUID(),
      client_type: 'web',
      source: 'manual',
      type: item.type,
      amount: item.amount,
      category_id: item.category_id,
      account_id: item.account_id || undefined,
      target_account_id: item.target_account_id || undefined,
      description: item.description,
      date: item.date,
      tags: item.tags || undefined,
    }]

    await api.post('/transactions', { items: payload })
    showManual.value = false
    input.value = ''
    toast.success('记账成功')
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
  <div class="pb-20 md:pb-4">
    <!-- 预算超支提醒 -->
    <div v-if="showBudgetWarning && budgetWarnings.length > 0" class="mb-3 space-y-2">
      <div
        v-for="(w, idx) in budgetWarnings"
        :key="idx"
        class="card flex items-center justify-between py-2.5 px-3"
        :style="w.status === 'exceeded' ? 'border-color: #fecaca; background: #fef2f2' : 'border-color: #fde68a; background: #fffbeb'"
      >
        <span class="text-sm" v-if="w.status === 'warning'" style="color: var(--color-text-primary)">
          ⚠️ {{ w.category_name }}预算已用{{ w.percent }}%
        </span>
        <span class="text-sm" v-else style="color: var(--color-expense)">
          🔴 {{ w.category_name }}已超支 ¥{{ formatAmount(w.spent - w.amount) }}
        </span>
        <button
          @click="budgetWarnings.splice(idx, 1); if (budgetWarnings.length === 0) showBudgetWarning = false"
          class="text-xs opacity-40 hover:opacity-100 ml-2"
        >✕</button>
      </div>
    </div>

    <!-- 本月摘要 -->
    <div class="grid grid-cols-3 gap-3 mb-4">
      <div class="card text-center cursor-pointer" @click="$router.push('/ledger')">
        <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">本月支出</p>
        <p class="text-base font-semibold amount-number amount-expense">¥{{ formatAmount(summary.expense) }}</p>
      </div>
      <div class="card text-center">
        <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">本月收入</p>
        <p class="text-base font-semibold amount-number amount-income">¥{{ formatAmount(summary.income) }}</p>
      </div>
      <div class="card text-center">
        <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">结余</p>
        <p class="text-base font-semibold amount-number amount-balance">¥{{ formatAmount(balance) }}</p>
      </div>
    </div>

    <!-- AI 输入区 -->
    <div class="card mb-4">
      <form @submit.prevent="handleAiParse" class="flex gap-2">
        <input
          v-model="input"
          type="text"
          class="flex-1 px-3 py-2.5 rounded-lg text-sm"
          style="border: 1px solid var(--color-border); background: var(--color-page-bg)"
          placeholder="说点什么就能记账... 如：午饭32，打车15"
          :disabled="loading"
        />
        <button
          type="submit"
          :disabled="loading || !input.trim()"
          class="btn-primary whitespace-nowrap disabled:opacity-50"
        >
          {{ loading ? '...' : '记账' }}
        </button>
        <button
          type="button"
          @click="showManual = true"
          class="btn-secondary whitespace-nowrap"
        >
          手动
        </button>
      </form>

      <!-- 快捷短语 -->
      <div class="flex gap-2 overflow-x-auto pb-1 mt-3">
        <button
          v-for="phrase in quickPhrases"
          :key="phrase"
          type="button"
          @click="appendPhrase(phrase)"
          class="px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition"
          style="background: var(--color-primary-50); color: var(--color-primary-700)"
        >
          {{ phrase }}
        </button>
      </div>

      <div v-if="error" class="mt-3 text-sm p-2.5 rounded-lg" style="color: var(--color-expense); background: #fef2f2; border: 1px solid #fecaca">
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
