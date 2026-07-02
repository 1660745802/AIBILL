<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import api from '@/api/index'
import EditTransactionModal from '@/components/EditTransactionModal.vue'

interface Transaction {
  id: number
  type: string
  amount: number
  description: string
  date: string
  category_id: number | null
  account_id: number | null
  target_account_id: number | null
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

// 筛选
const keyword = ref('')
const filterType = ref('')
const startDate = ref('')
const endDate = ref('')

onMounted(() => fetchData())

watch([filterType, startDate, endDate], () => {
  page.value = 1
  fetchData()
})

async function fetchData() {
  loading.value = true
  try {
    const params: Record<string, any> = {
      page: page.value,
      page_size: pageSize,
    }
    if (keyword.value) params.keyword = keyword.value
    if (filterType.value) params.type = filterType.value
    if (startDate.value) params.start_date = startDate.value
    if (endDate.value) params.end_date = endDate.value

    const { data } = await api.get('/transactions', { params })
    if (data.code === 0) {
      transactions.value = data.data.items
      total.value = data.data.total
    }
  } catch { /* ignore */ }
  finally { loading.value = false }
}

function handleSearch() {
  page.value = 1
  fetchData()
}

async function handleDelete(id: number) {
  if (!confirm('确定删除这笔交易？')) return
  try {
    await api.delete(`/transactions/${id}`)
    fetchData()
  } catch { /* ignore */ }
}

function prevPage() {
  if (page.value > 1) { page.value--; fetchData() }
}
function nextPage() {
  if (page.value * pageSize < total.value) { page.value++; fetchData() }
}

// 按日期分组
const groupedTransactions = computed(() => {
  const groups: Record<string, Transaction[]> = {}
  for (const tx of transactions.value) {
    if (!groups[tx.date]) groups[tx.date] = []
    groups[tx.date].push(tx)
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
})

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekDays[d.getDay()]}`
}

// 编辑弹窗
const showEditModal = ref(false)
const editingTransaction = ref<Transaction | null>(null)

function handleRowClick(tx: Transaction) {
  editingTransaction.value = tx
  showEditModal.value = true
}

function handleEditSaved() {
  showEditModal.value = false
  editingTransaction.value = null
  fetchData()
}
</script>

<template>
  <div class="pb-4">
    <!-- 搜索和筛选 -->
    <div class="bg-white px-4 py-3 mb-2 space-y-2">
      <div class="flex gap-2">
        <input
          v-model="keyword"
          type="text"
          class="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="搜索描述..."
          @keyup.enter="handleSearch"
        />
        <button
          @click="handleSearch"
          class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
        >
          搜索
        </button>
      </div>
      <div class="flex gap-2">
        <select
          v-model="filterType"
          class="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none"
        >
          <option value="">全部类型</option>
          <option value="expense">支出</option>
          <option value="income">收入</option>
          <option value="transfer">转账</option>
        </select>
        <input
          v-model="startDate"
          type="date"
          class="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none"
        />
        <span class="text-xs text-gray-400 self-center">~</span>
        <input
          v-model="endDate"
          type="date"
          class="px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none"
        />
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="text-center py-8 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="transactions.length === 0" class="text-center py-8 text-gray-400 text-sm">
      暂无交易记录
    </div>

    <div v-else>
      <div v-for="[date, items] in groupedTransactions" :key="date" class="mb-2">
        <div class="px-4 py-2 text-xs text-gray-500 bg-gray-50">{{ formatDate(date) }}</div>
        <div class="bg-white">
          <div
            v-for="tx in items"
            :key="tx.id"
            @click="handleRowClick(tx)"
            class="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50"
          >
            <div class="flex items-center gap-2">
              <span class="text-base">{{ tx.category_icon || '📦' }}</span>
              <div>
                <div class="text-sm text-gray-800">
                  {{ tx.description || tx.category_name || '未分类' }}
                </div>
                <div class="text-xs text-gray-400">
                  {{ tx.account_name || '' }}
                  <span v-if="tx.type === 'transfer' && tx.target_account_name">→ {{ tx.target_account_name }}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-3">
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
                @click.stop="handleDelete(tx.id)"
                class="text-xs text-gray-300 hover:text-red-500"
              >
                ✕
              </button>
            </div>
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

  <!-- 编辑弹窗 -->
  <EditTransactionModal
    :show="showEditModal"
    :transaction="editingTransaction"
    @close="showEditModal = false"
    @saved="handleEditSaved"
  />
</template>
