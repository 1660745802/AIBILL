<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'
import { useConfirm } from '@/composables/useConfirm'
import PageHeader from '@/components/ui/PageHeader.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

import type { Transaction } from '@/api/types'

const router = useRouter()
const confirm = useConfirm()

const transactions = ref<Transaction[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = 20

const totalPages = computed(() => Math.ceil(total.value / pageSize) || 1)

onMounted(() => fetchData())

async function fetchData() {
  loading.value = true
  try {
    const { data } = await api.get('/transactions/trash', {
      params: { page: page.value, page_size: pageSize },
    })
    if (data.code === 0) {
      transactions.value = data.data.items
      total.value = data.data.total
    }
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function handleRestore(id: number) {
  try {
    const { data } = await api.post(`/transactions/${id}/restore`)
    if (data.code === 0) {
      fetchData()
    }
  } catch { /* ignore */ }
}

async function handlePermanentDelete(id: number) {
  const ok = await confirm({
    title: '永久删除',
    body: '这笔记录将被彻底移除，无法再恢复，也不会计入任何统计。',
    danger: true,
  })
  if (!ok) return
  try {
    const { data } = await api.delete(`/transactions/${id}/permanent`)
    if (data.code === 0) {
      fetchData()
    }
  } catch { /* ignore */ }
}

function moneyTone(type: string) {
  if (type === 'income') return 'income'
  if (type === 'transfer') return 'info'
  return 'expense'
}
function moneySign(type: string) {
  if (type === 'income') return 'plus'
  if (type === 'transfer') return 'none'
  return 'minus'
}

function prevPage() {
  if (page.value > 1) { page.value--; fetchData() }
}
function nextPage() {
  if (page.value * pageSize < total.value) { page.value++; fetchData() }
}
</script>

<template>
  <div class="pb-24 md:pb-6">
    <PageHeader
      title="回收站"
      :subtitle="total > 0 ? `${total} 条待清理 · 30 天后自动清除` : '删除的记录会在 30 天后自动清除'"
    />

    <!-- 加载态 -->
    <div v-if="loading" class="sheet p-3">
      <Skeleton variant="rows" :lines="4" />
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else-if="transactions.length === 0"
      icon="trash"
      ruled
      title="回收站是空的"
      description="删除的交易会先放进这里，30 天内都能恢复。现在它空空如也。"
    >
      <button class="btn btn-primary" @click="router.push('/')">
        <AppIcon name="pen" :size="15" />
        去记一笔
      </button>
    </EmptyState>

    <!-- 列表 -->
    <template v-else>
      <div class="sheet">
        <SheetRow v-for="tx in transactions" :key="tx.id">
          <span class="tx-icon">{{ tx.category_icon || '📦' }}</span>
          <div class="min-w-0 flex-1">
            <div class="text-sm text-ink-1 truncate">
              {{ tx.description || tx.category_name || '未分类' }}
            </div>
            <div class="text-[11px] text-ink-3 truncate">
              删除于 {{ tx.deleted_at ? tx.deleted_at.slice(0, 10) : tx.date }}
              <span v-if="tx.account_name"> · {{ tx.account_name }}</span>
            </div>
          </div>
          <Money
            :value="tx.amount"
            size="sm"
            :tone="moneyTone(tx.type)"
            :sign="moneySign(tx.type)"
            class="shrink-0"
          />
          <div class="flex items-center gap-2 shrink-0">
            <button class="btn btn-outline btn-sm" @click="handleRestore(tx.id)">恢复</button>
            <button class="btn btn-danger btn-sm" @click="handlePermanentDelete(tx.id)">永久删除</button>
          </div>
        </SheetRow>
      </div>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-4 py-4">
        <button class="btn btn-outline btn-sm" :disabled="page <= 1" @click="prevPage">
          上一页
        </button>
        <span class="text-xs text-ink-3 amt">{{ page }} / {{ totalPages }}</span>
        <button class="btn btn-outline btn-sm" :disabled="page * pageSize >= total" @click="nextPage">
          下一页
        </button>
      </div>
    </template>
  </div>
</template>
