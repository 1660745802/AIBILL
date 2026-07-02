<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import api from '@/api/index'

interface Transaction {
  id: number
  type: string
  amount: number
  description: string
  date: string
  category_id: number | null
  account_id: number | null
  target_account_id: number | null
}

const props = defineProps<{
  show: boolean
  transaction: Transaction | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const type = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref('')
const description = ref('')
const date = ref('')
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const targetAccountId = ref<number | null>(null)
const saving = ref(false)
const error = ref('')

const categories = ref<any[]>([])
const accounts = ref<any[]>([])

onMounted(async () => {
  try {
    const [catRes, accRes] = await Promise.all([
      api.get('/categories'),
      api.get('/accounts'),
    ])
    if (catRes.data.code === 0) categories.value = catRes.data.data.items
    if (accRes.data.code === 0) accounts.value = accRes.data.data.items
  } catch { /* ignore */ }
})

watch(() => props.transaction, (tx) => {
  if (tx) {
    type.value = tx.type as 'expense' | 'income' | 'transfer'
    amount.value = (tx.amount / 100).toFixed(2)
    description.value = tx.description || ''
    date.value = tx.date
    categoryId.value = tx.category_id
    accountId.value = tx.account_id
    targetAccountId.value = tx.target_account_id
    error.value = ''
  }
}, { immediate: true })

function filteredCategories() {
  return categories.value.filter((c: any) => c.type === type.value)
}

async function handleSave() {
  if (!props.transaction) return
  const amountCents = Math.round(parseFloat(amount.value) * 100)
  if (!amountCents || amountCents <= 0) {
    error.value = '请输入有效金额'
    return
  }

  saving.value = true
  error.value = ''

  try {
    const payload: Record<string, any> = {
      type: type.value,
      amount: amountCents,
      description: description.value,
      date: date.value,
    }

    if (type.value === 'transfer') {
      payload.category_id = null
      payload.target_account_id = targetAccountId.value
    } else {
      payload.category_id = categoryId.value
      payload.target_account_id = null
    }

    if (accountId.value) {
      payload.account_id = accountId.value
    }

    const { data } = await api.put(`/transactions/${props.transaction.id}`, payload)
    if (data.code === 0) {
      emit('saved')
    } else {
      error.value = data.message || '保存失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center">
    <!-- 遮罩 -->
    <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>

    <!-- 弹窗 -->
    <div class="relative bg-white rounded-lg w-[90%] max-w-md mx-4 p-5 max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-medium text-gray-800">编辑交易</h3>
        <button @click="emit('close')" class="text-gray-400 hover:text-gray-600 text-lg">✕</button>
      </div>

      <form @submit.prevent="handleSave" class="space-y-3">
        <!-- 类型选择 -->
        <div class="flex gap-2">
          <button
            v-for="t in [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }, { value: 'transfer', label: '转账' }]"
            :key="t.value"
            type="button"
            @click="type = t.value as any"
            class="flex-1 py-1.5 text-sm rounded-md border transition-colors"
            :class="type === t.value ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 border-gray-300 hover:bg-gray-50'"
          >
            {{ t.label }}
          </button>
        </div>

        <!-- 金额 -->
        <div>
          <label class="text-xs text-gray-500">金额（元）</label>
          <input
            v-model="amount"
            type="number"
            step="0.01"
            min="0.01"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
            placeholder="金额"
          />
        </div>

        <!-- 分类（非转账时显示） -->
        <div v-if="type !== 'transfer'">
          <label class="text-xs text-gray-500">分类</label>
          <select
            v-model="categoryId"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
          >
            <option :value="null">选择分类</option>
            <option v-for="cat in filteredCategories()" :key="cat.id" :value="cat.id">
              {{ cat.icon }} {{ cat.name }}
            </option>
          </select>
        </div>

        <!-- 账户 -->
        <div>
          <label class="text-xs text-gray-500">{{ type === 'transfer' ? '来源账户' : '账户' }}</label>
          <select
            v-model="accountId"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
          >
            <option :value="null">选择账户</option>
            <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
              {{ acc.icon }} {{ acc.name }}
            </option>
          </select>
        </div>

        <!-- 目标账户（转账时） -->
        <div v-if="type === 'transfer'">
          <label class="text-xs text-gray-500">目标账户</label>
          <select
            v-model="targetAccountId"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
          >
            <option :value="null">选择目标账户</option>
            <option v-for="acc in accounts.filter(a => a.id !== accountId)" :key="acc.id" :value="acc.id">
              {{ acc.icon }} {{ acc.name }}
            </option>
          </select>
        </div>

        <!-- 描述 -->
        <div>
          <label class="text-xs text-gray-500">描述</label>
          <input
            v-model="description"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
            placeholder="备注（选填）"
          />
        </div>

        <!-- 日期 -->
        <div>
          <label class="text-xs text-gray-500">日期</label>
          <input
            v-model="date"
            type="date"
            class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mt-0.5"
          />
        </div>

        <!-- 错误提示 -->
        <div v-if="error" class="text-sm text-red-600 bg-red-50 p-2 rounded">
          {{ error }}
        </div>

        <!-- 保存按钮 -->
        <button
          type="submit"
          :disabled="saving || !amount || parseFloat(amount) <= 0"
          class="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </form>
    </div>
  </div>
</template>
