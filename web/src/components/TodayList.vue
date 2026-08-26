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
  <div class="card">
    <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">今日流水</h3>

    <EmptyState
      v-if="transactions.length === 0"
      icon="📝"
      title="今天还没有记账"
      description="在上方输入就能快速记账"
    />

    <div v-else class="space-y-1">
      <div
        v-for="tx in transactions"
        :key="tx.id"
        class="flex items-center justify-between py-2.5"
        :style="'border-bottom: 1px solid var(--color-border-light)'"
      >
        <div class="flex items-center gap-2.5">
          <span class="text-base">{{ tx.category_icon || '📦' }}</span>
          <div>
            <div class="text-sm" style="color: var(--color-text-primary)">{{ tx.description || tx.category_name || '未分类' }}</div>
            <div class="text-[11px]" style="color: var(--color-text-muted)">{{ tx.account_name || '' }}</div>
          </div>
        </div>
        <span
          class="text-sm font-medium amount-number"
          :class="{
            'amount-expense': tx.type === 'expense',
            'amount-income': tx.type === 'income',
            'amount-balance': tx.type === 'transfer',
          }"
        >
          {{ tx.type === 'income' ? '+' : '-' }}¥{{ formatAmount(tx.amount) }}
        </span>
      </div>
    </div>
  </div>
</template>
