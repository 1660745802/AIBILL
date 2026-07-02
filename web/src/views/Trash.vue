<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'

interface Transaction {
  id: number
  type: string
  amount: number
  description: string
  date: string
  deleted_at: string
  category_name: string
  category_icon: string
  account_name: string
  target_account_name?: string
}

const transactions = ref<Transaction[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = 20

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
  if (!confirm('永久删除后无法恢复，确定吗？')) return
  try {
    const { data } = await api.delete(`/transactions/${id}/permanent`)
    if (data.code === 0) {
      fetchData()
    }
  } catch { /* ignore */ }
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function prevPage() {
  if (page.value > 1) { page.value--; fetchData() }
}
function nextPage() {
  if (page.value * pageSize < total.value) { page.value++; fetchData() }
}
</script>

<template>
  <div class="pb-4">
    <!-- 标题 -->
    <div class="bg-white px-4 py-3 mb-2">
      <h2 class="text-base font-medium text-gray-800">🗑️ 回收站</h2>
      <p class="text-xs text-gray-400 mt-0.5">已删除的交易可在此恢复或永久删除</p>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-8 text-gray-400 text-sm">加载中...</div>

    <!-- 空状态 -->
    <div v-else-if="transactions.length === 0" class="text-center py-16 text-gray-400">
      <div class="text-4xl mb-2">🗑️</div>
      <div class="text-sm">回收站是空的</div>
    </div>

    <!-- 列表 -->
    <div v-else>
      <div class="bg-white">
        <div
          v-for="tx in transactions"
          :key="tx.id"
          class="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0"
        >
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <span class="text-base">{{ tx.category_icon || '📦' }}</span>
            <div class="min-w-0 flex-1">
              <div class="text-sm text-gray-800 truncate">
                {{ tx.description || tx.category_name || '未分类' }}
              </div>
              <div class="text-xs text-gray-400">
                {{ tx.date }}
                <span v-if="tx.account_name" class="ml-1">· {{ tx.account_name }}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 ml-2 shrink-0">
            <span
              class="text-sm font-medium"
              :class="{
                'text-red-500': tx.type === 'expense',
                'text-green-500': tx.type === 'income',
                'text-blue-500': tx.type === 'transfer',
              }"
            >
              {{ tx.type === 'income' ? '+' : '-' }}¥{{ formatAmount(tx.amount) }}
            </span>
            <button
              @click="handleRestore(tx.id)"
              class="text-xs px-2 py-1 text-blue-600 border border-blue-200 rounded hover:bg-blue-50"
            >
              恢复
            </button>
            <button
              @click="handlePermanentDelete(tx.id)"
              class="text-xs px-2 py-1 text-red-500 border border-red-200 rounded hover:bg-red-50"
            >
              永久删除
            </button>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div class="flex items-center justify-center gap-4 py-4">
        <button
          @click="prevPage"
          :disabled="page <= 1"
          class="px-3 py-1 text-sm border rounded disabled:opacity-30"
        >
          上一页
        </button>
        <span class="text-xs text-gray-500">{{ page }} / {{ Math.ceil(total / pageSize) || 1 }}</span>
        <button
          @click="nextPage"
          :disabled="page * pageSize >= total"
          class="px-3 py-1 text-sm border rounded disabled:opacity-30"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>
