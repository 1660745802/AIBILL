<script setup lang="ts">
import EmptyState from '@/components/EmptyState.vue'

defineProps<{
  transactions: any[]
}>()

defineEmits<{
  refresh: []
}>()

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <div class="bg-white px-4 py-4">
    <h3 class="text-sm font-medium text-gray-700 mb-3">今日流水</h3>

    <EmptyState
      v-if="transactions.length === 0"
      icon="📝"
      title="今天还没有记账"
      description="在上方输入就能快速记账"
    />

    <div v-else class="space-y-2">
      <div
        v-for="tx in transactions"
        :key="tx.id"
        class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0"
      >
        <div class="flex items-center gap-2">
          <span class="text-base">{{ tx.category_icon || '📦' }}</span>
          <div>
            <div class="text-sm text-gray-800">{{ tx.description || tx.category_name || '未分类' }}</div>
            <div class="text-xs text-gray-400">{{ tx.account_name || '' }}</div>
          </div>
        </div>
        <div
          class="text-sm font-medium"
          :class="{
            'text-red-500': tx.type === 'expense',
            'text-green-500': tx.type === 'income',
            'text-blue-500': tx.type === 'transfer',
          }"
        >
          {{ tx.type === 'income' ? '+' : '-' }}¥{{ formatAmount(tx.amount) }}
        </div>
      </div>
    </div>
  </div>
</template>
