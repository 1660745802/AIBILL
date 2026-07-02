<script setup lang="ts">
import { ref } from 'vue'

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

const editableItems = ref<ParsedItem[]>([...props.items])

function removeItem(index: number) {
  editableItems.value.splice(index, 1)
  if (editableItems.value.length === 0) {
    emit('cancel')
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
        <div class="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
          <span class="text-xs text-gray-400">{{ item.date }}</span>
          <button
            @click="removeItem(index)"
            class="text-xs text-red-500 hover:text-red-700"
          >
            删除
          </button>
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
