<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'

interface ParsedItem {
  type: string
  amount: number
  category_id: number | null
  category_name: string
  category_icon: string
  description: string
  date: string
  account_id: number | null
  account_name: string
  target_account_id?: number | null
  target_account_name?: string
}

const props = defineProps<{
  items: ParsedItem[]
}>()

const emit = defineEmits<{
  confirm: [items: ParsedItem[]]
  cancel: []
}>()

const editableItems = ref<ParsedItem[]>(JSON.parse(JSON.stringify(props.items)))
const categories = ref<any[]>([])
const accounts = ref<any[]>([])
const editingIndex = ref<number | null>(null)

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

function removeItem(index: number) {
  editableItems.value.splice(index, 1)
  if (editableItems.value.length === 0) {
    emit('cancel')
  }
}

function toggleEdit(index: number) {
  editingIndex.value = editingIndex.value === index ? null : index
}

function updateCategory(index: number, categoryId: number) {
  const cat = categories.value.find((c: any) => c.id === categoryId)
  if (cat) {
    editableItems.value[index].category_id = cat.id
    editableItems.value[index].category_name = cat.name
    editableItems.value[index].category_icon = cat.icon
  }
}

function updateAccount(index: number, accountId: number) {
  const acc = accounts.value.find((a: any) => a.id === accountId)
  if (acc) {
    editableItems.value[index].account_id = acc.id
    editableItems.value[index].account_name = acc.name
  }
}

function updateAmount(index: number, value: string) {
  const cents = Math.round(parseFloat(value) * 100)
  if (cents > 0) {
    editableItems.value[index].amount = cents
  }
}

function confirmAll() {
  emit('confirm', editableItems.value)
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'expense': return '支出'
    case 'income': return '收入'
    case 'transfer': return '转账'
    default: return type
  }
}
</script>

<template>
  <div class="bg-white px-4 py-4 mb-2">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-medium text-gray-700">
        ✅ 解析结果（{{ editableItems.length }} 条）
      </h3>
    </div>

    <div class="space-y-2">
      <div
        v-for="(item, index) in editableItems"
        :key="index"
        class="border border-gray-200 rounded-lg p-3"
      >
        <!-- 展示行 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-lg">{{ item.category_icon || '📦' }}</span>
            <div>
              <div class="text-sm font-medium text-gray-800">
                {{ item.category_name || getTypeLabel(item.type) }}
              </div>
              <div class="text-xs text-gray-500">{{ item.description }}</div>
            </div>
          </div>
          <div class="text-right">
            <div class="text-sm font-semibold" :class="item.type === 'income' ? 'text-green-600' : 'text-gray-800'">
              {{ item.type === 'income' ? '+' : '-' }}¥{{ formatAmount(item.amount) }}
            </div>
            <div class="text-xs text-gray-400">
              {{ item.account_name || '未指定' }}
              <span v-if="item.type === 'transfer' && item.target_account_name">
                → {{ item.target_account_name }}
              </span>
            </div>
          </div>
        </div>

        <!-- 操作栏 -->
        <div class="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
          <span class="text-xs text-gray-400">{{ item.date }}</span>
          <div class="flex gap-2">
            <button @click="toggleEdit(index)" class="text-xs text-blue-500 hover:text-blue-700">
              {{ editingIndex === index ? '收起' : '编辑' }}
            </button>
            <button @click="removeItem(index)" class="text-xs text-red-500 hover:text-red-700">
              删除
            </button>
          </div>
        </div>

        <!-- 编辑面板 -->
        <div v-if="editingIndex === index" class="mt-3 pt-3 border-t border-gray-100 space-y-2">
          <div class="flex gap-2">
            <div class="flex-1">
              <label class="text-xs text-gray-500">金额</label>
              <input
                :value="formatAmount(item.amount)"
                @change="updateAmount(index, ($event.target as HTMLInputElement).value)"
                type="number"
                step="0.01"
                min="0.01"
                class="w-full px-2 py-1 border border-gray-300 rounded text-sm mt-0.5"
              />
            </div>
            <div class="flex-1">
              <label class="text-xs text-gray-500">日期</label>
              <input
                v-model="editableItems[index].date"
                type="date"
                class="w-full px-2 py-1 border border-gray-300 rounded text-sm mt-0.5"
              />
            </div>
          </div>
          <div class="flex gap-2">
            <div class="flex-1" v-if="item.type !== 'transfer'">
              <label class="text-xs text-gray-500">分类</label>
              <select
                :value="item.category_id"
                @change="updateCategory(index, Number(($event.target as HTMLSelectElement).value))"
                class="w-full px-2 py-1 border border-gray-300 rounded text-sm mt-0.5"
              >
                <option v-for="cat in categories.filter((c: any) => c.type === item.type)" :key="cat.id" :value="cat.id">
                  {{ cat.icon }} {{ cat.name }}
                </option>
              </select>
            </div>
            <div class="flex-1">
              <label class="text-xs text-gray-500">账户</label>
              <select
                :value="item.account_id"
                @change="updateAccount(index, Number(($event.target as HTMLSelectElement).value))"
                class="w-full px-2 py-1 border border-gray-300 rounded text-sm mt-0.5"
              >
                <option :value="null">未指定</option>
                <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                  {{ acc.icon }} {{ acc.name }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex gap-3 mt-4">
      <button
        @click="confirmAll"
        class="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
      >
        全部确认
      </button>
      <button
        @click="emit('cancel')"
        class="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        取消
      </button>
    </div>
  </div>
</template>
