<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import api from '@/api/index'

const props = defineProps<{
  initialDescription?: string
}>()

const emit = defineEmits<{
  submit: [item: any]
  cancel: []
}>()

const type = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref('')
const description = ref(props.initialDescription || '')
const date = ref(new Date().toISOString().slice(0, 10))
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const targetAccountId = ref<number | null>(null)

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

const filteredCategories = computed(() =>
  categories.value.filter((c: any) => c.type === type.value)
)

watch(type, () => {
  categoryId.value = null
})

function handleSubmit() {
  const amountCents = Math.round(parseFloat(amount.value) * 100)
  if (!amountCents || amountCents <= 0) return

  emit('submit', {
    type: type.value,
    amount: amountCents,
    category_id: type.value === 'transfer' ? null : categoryId.value,
    account_id: accountId.value,
    target_account_id: type.value === 'transfer' ? targetAccountId.value : null,
    description: description.value,
    date: date.value,
  })
}
</script>

<template>
  <div class="bg-white px-4 py-4 mb-2">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-medium text-gray-700">手动记账</h3>
      <button @click="emit('cancel')" class="text-xs text-gray-400 hover:text-gray-600">✕ 关闭</button>
    </div>

    <form @submit.prevent="handleSubmit" class="space-y-3">
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
        <input
          v-model="amount"
          type="number"
          step="0.01"
          min="0.01"
          class="w-full px-3 py-2 border border-gray-300 rounded-md text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="金额"
        />
      </div>

      <!-- 分类（非转账时显示） -->
      <div v-if="type !== 'transfer'">
        <select
          v-model="categoryId"
          class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option :value="null">选择分类</option>
          <option v-for="cat in filteredCategories" :key="cat.id" :value="cat.id">
            {{ cat.icon }} {{ cat.name }}
          </option>
        </select>
      </div>

      <!-- 账户 -->
      <div class="flex gap-2">
        <select
          v-model="accountId"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option :value="null">来源账户</option>
          <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
            {{ acc.icon }} {{ acc.name }}
          </option>
        </select>
        <select
          v-if="type === 'transfer'"
          v-model="targetAccountId"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option :value="null">目标账户</option>
          <option v-for="acc in accounts.filter(a => a.id !== accountId)" :key="acc.id" :value="acc.id">
            {{ acc.icon }} {{ acc.name }}
          </option>
        </select>
      </div>

      <!-- 描述 -->
      <input
        v-model="description"
        type="text"
        class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="备注（选填）"
      />

      <!-- 日期 -->
      <input
        v-model="date"
        type="date"
        class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <!-- 提交 -->
      <button
        type="submit"
        class="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        :disabled="!amount || parseFloat(amount) <= 0"
      >
        保存
      </button>
    </form>
  </div>
</template>
