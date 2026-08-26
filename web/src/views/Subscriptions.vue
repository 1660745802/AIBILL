<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'

const toast = useToast()

interface Subscription {
  id: number
  name: string
  amount: number // cents
  cycle: 'monthly' | 'quarterly' | 'yearly'
  category_id: number | null
  category_name: string | null
  account_id: number | null
  account_name: string | null
  start_date: string
  next_payment_date: string
  reminder_days: number
  auto_record: number
  status: 'active' | 'cancelled'
  note: string | null
  created_at: string
}

interface Category {
  id: number
  name: string
  icon: string
}

interface Account {
  id: number
  name: string
}

type StatusFilter = 'active' | 'cancelled' | 'all'

const subscriptions = ref<Subscription[]>([])
const upcoming = ref<Subscription[]>([])
const monthlyTotal = ref(0)
const yearlyTotal = ref(0)
const loading = ref(false)
const statusFilter = ref<StatusFilter>('active')

const categories = ref<Category[]>([])
const accounts = ref<Account[]>([])

// Form state
const showForm = ref(false)
const editingId = ref<number | null>(null)
const formSaving = ref(false)
const form = ref({
  name: '',
  amount: '',
  cycle: 'monthly' as Subscription['cycle'],
  start_date: new Date().toISOString().slice(0, 10),
  category_id: null as number | null,
  account_id: null as number | null,
  reminder_days: 3,
  auto_record: true,
  note: '',
})

const filterTabs: { key: StatusFilter; label: string }[] = [
  { key: 'active', label: '活跃' },
  { key: 'cancelled', label: '已取消' },
  { key: 'all', label: '全部' },
]

const cycleConfig = {
  monthly: { label: '月付', badge: '月', color: 'bg-blue-100 text-blue-700' },
  quarterly: { label: '季付', badge: '季', color: 'bg-purple-100 text-purple-700' },
  yearly: { label: '年付', badge: '年', color: 'bg-amber-100 text-amber-700' },
}

const filteredSubscriptions = computed(() => {
  return subscriptions.value
})

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

async function fetchSubscriptions() {
  loading.value = true
  try {
    const { data } = await api.get('/subscriptions', {
      params: { status: statusFilter.value },
    })
    if (data.code === 0) {
      subscriptions.value = data.data.items
      upcoming.value = data.data.upcoming || []
      monthlyTotal.value = data.data.monthly_total || 0
      yearlyTotal.value = data.data.yearly_total || 0
    }
  } catch {
    toast.error('加载订阅列表失败')
  } finally {
    loading.value = false
  }
}

async function fetchCategories() {
  try {
    const { data } = await api.get('/categories')
    if (data.code === 0) {
      categories.value = data.data || []
    }
  } catch { /* ignore */ }
}

async function fetchAccounts() {
  try {
    const { data } = await api.get('/accounts')
    if (data.code === 0) {
      accounts.value = data.data || []
    }
  } catch { /* ignore */ }
}

function resetForm() {
  form.value = {
    name: '',
    amount: '',
    cycle: 'monthly',
    start_date: new Date().toISOString().slice(0, 10),
    category_id: null,
    account_id: null,
    reminder_days: 3,
    auto_record: true,
    note: '',
  }
  editingId.value = null
}

function openAddForm() {
  resetForm()
  showForm.value = true
}

function openEditForm(sub: Subscription) {
  editingId.value = sub.id
  form.value = {
    name: sub.name,
    amount: (sub.amount / 100).toString(),
    cycle: sub.cycle,
    start_date: sub.start_date,
    category_id: sub.category_id,
    account_id: sub.account_id,
    reminder_days: sub.reminder_days,
    auto_record: !!sub.auto_record,
    note: sub.note || '',
  }
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  resetForm()
}

async function saveSubscription() {
  if (!form.value.name.trim()) {
    toast.warning('请输入订阅名称')
    return
  }
  const amountNum = parseFloat(form.value.amount)
  if (isNaN(amountNum) || amountNum <= 0) {
    toast.warning('请输入有效金额')
    return
  }

  formSaving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      amount: Math.round(amountNum * 100),
      cycle: form.value.cycle,
      start_date: form.value.start_date,
      category_id: form.value.category_id || undefined,
      account_id: form.value.account_id || undefined,
      reminder_days: form.value.reminder_days,
      auto_record: form.value.auto_record ? 1 : 0,
      note: form.value.note.trim() || undefined,
    }

    if (editingId.value) {
      const { data } = await api.put(`/subscriptions/${editingId.value}`, payload)
      if (data.code === 0) {
        toast.success('订阅已更新')
        closeForm()
        fetchSubscriptions()
      } else {
        toast.error(data.message || '更新失败')
      }
    } else {
      const { data } = await api.post('/subscriptions', payload)
      if (data.code === 0) {
        toast.success('订阅已添加')
        closeForm()
        fetchSubscriptions()
      } else {
        toast.error(data.message || '添加失败')
      }
    }
  } catch (e: any) {
    toast.error(e.response?.data?.message || '保存失败')
  } finally {
    formSaving.value = false
  }
}

async function cancelSubscription(sub: Subscription) {
  if (!confirm(`确定取消订阅「${sub.name}」？`)) return
  try {
    const { data } = await api.post(`/subscriptions/${sub.id}/cancel`)
    if (data.code === 0) {
      toast.success('已取消订阅')
      fetchSubscriptions()
    } else {
      toast.error(data.message || '操作失败')
    }
  } catch {
    toast.error('操作失败')
  }
}

async function renewSubscription(sub: Subscription) {
  try {
    const { data } = await api.post(`/subscriptions/${sub.id}/renew`)
    if (data.code === 0) {
      toast.success('已恢复订阅')
      fetchSubscriptions()
    } else {
      toast.error(data.message || '操作失败')
    }
  } catch {
    toast.error('操作失败')
  }
}

async function deleteSubscription(sub: Subscription) {
  if (!confirm(`确定永久删除「${sub.name}」？此操作不可恢复。`)) return
  try {
    const { data } = await api.delete(`/subscriptions/${sub.id}`)
    if (data.code === 0) {
      toast.success('已删除')
      fetchSubscriptions()
    } else {
      toast.error(data.message || '删除失败')
    }
  } catch {
    toast.error('删除失败')
  }
}

function switchFilter(key: StatusFilter) {
  statusFilter.value = key
  fetchSubscriptions()
}

onMounted(() => {
  fetchSubscriptions()
  fetchCategories()
  fetchAccounts()
})
</script>

<template>
  <div class="px-4 py-5 pb-20">
    <!-- Header -->
    <div class="mb-5">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-bold text-[color:var(--color-text-primary)]">🔁 订阅管理</h1>
          <p class="text-xs text-gray-400 mt-1">管理你的周期性订阅支出</p>
        </div>
        <button
          @click="openAddForm"
          class="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          + 新增
        </button>
      </div>

      <!-- Summary Stats -->
      <div class="mt-4 flex gap-3">
        <div class="flex-1 bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl p-3 text-white">
          <p class="text-[10px] opacity-80">月均支出</p>
          <p class="text-lg font-bold mt-0.5">¥{{ formatAmount(monthlyTotal) }}</p>
        </div>
        <div class="flex-1 bg-gradient-to-r from-purple-500 to-purple-600 rounded-xl p-3 text-white">
          <p class="text-[10px] opacity-80">年度支出</p>
          <p class="text-lg font-bold mt-0.5">¥{{ formatAmount(yearlyTotal) }}</p>
        </div>
      </div>
    </div>

    <!-- Upcoming Reminders -->
    <div v-if="upcoming.length > 0" class="mb-5">
      <h2 class="text-sm font-semibold text-amber-700 mb-2">⏰ 即将扣费</h2>
      <div class="space-y-2">
        <div
          v-for="item in upcoming"
          :key="'upcoming-' + item.id"
          class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between"
        >
          <div class="flex items-center gap-3">
            <span class="text-lg">⚡</span>
            <div>
              <p class="text-sm font-medium text-[color:var(--color-text-primary)]">{{ item.name }}</p>
              <p class="text-[11px] text-amber-600">{{ item.next_payment_date }}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-sm font-bold text-[color:var(--color-text-primary)]">¥{{ formatAmount(item.amount) }}</p>
            <p class="text-[11px] text-amber-600 font-medium">{{ daysUntil(item.next_payment_date) }}天后</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Filter Tabs -->
    <div class="flex gap-2 mb-4 overflow-x-auto pb-1">
      <button
        v-for="tab in filterTabs"
        :key="tab.key"
        @click="switchFilter(tab.key)"
        class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all"
        :class="statusFilter === tab.key
          ? 'bg-gray-800 text-white shadow-sm'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
        <div class="h-4 bg-gray-100 rounded w-3/4 mb-2"></div>
        <div class="h-3 bg-gray-50 rounded w-1/2"></div>
      </div>
    </div>

    <!-- Subscription List -->
    <div v-else-if="filteredSubscriptions.length > 0" class="space-y-3">
      <div
        v-for="sub in filteredSubscriptions"
        :key="sub.id"
        class="bg-white rounded-xl border border-gray-100 shadow-sm p-4 transition-all hover:shadow-md"
        :class="{ 'opacity-50': sub.status === 'cancelled' }"
      >
        <div class="flex items-start gap-3">
          <!-- Icon -->
          <div class="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center text-lg flex-shrink-0">
            {{ categories.find(c => c.id === sub.category_id)?.icon || '🔁' }}
          </div>

          <!-- Content -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <h3
                class="text-sm font-semibold text-[color:var(--color-text-primary)] truncate"
                :class="{ 'line-through': sub.status === 'cancelled' }"
              >
                {{ sub.name }}
              </h3>
              <span
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
                :class="cycleConfig[sub.cycle].color"
              >
                {{ cycleConfig[sub.cycle].badge }}
              </span>
            </div>
            <div class="mt-1 flex items-center gap-3 text-xs text-gray-400">
              <span v-if="sub.next_payment_date && sub.status === 'active'">
                下次：{{ formatDate(sub.next_payment_date) }}
              </span>
              <span v-if="sub.account_name">{{ sub.account_name }}</span>
              <span v-if="sub.category_name">{{ sub.category_name }}</span>
            </div>
          </div>

          <!-- Amount -->
          <div class="text-right flex-shrink-0">
            <p class="text-sm font-bold text-[color:var(--color-text-primary)]">¥{{ formatAmount(sub.amount) }}</p>
            <p class="text-[10px] text-gray-400">/ {{ cycleConfig[sub.cycle].badge }}</p>
          </div>
        </div>

        <!-- Actions -->
        <div class="mt-3 pt-3 border-t border-gray-50 flex items-center gap-2">
          <button
            @click="openEditForm(sub)"
            class="px-2.5 py-1 text-[11px] text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
          >
            编辑
          </button>
          <button
            v-if="sub.status === 'active'"
            @click="cancelSubscription(sub)"
            class="px-2.5 py-1 text-[11px] text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded-md transition-colors"
          >
            取消
          </button>
          <button
            v-else
            @click="renewSubscription(sub)"
            class="px-2.5 py-1 text-[11px] text-green-600 hover:text-green-700 hover:bg-green-50 rounded-md transition-colors"
          >
            恢复
          </button>
          <button
            @click="deleteSubscription(sub)"
            class="px-2.5 py-1 text-[11px] text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors ml-auto"
          >
            删除
          </button>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else class="flex flex-col items-center justify-center py-16 px-4">
      <span class="text-5xl mb-4">🔁</span>
      <p class="text-sm font-medium text-gray-500">还没有订阅</p>
      <p class="mt-1 text-xs text-gray-400 text-center">
        添加你的定期订阅，自动跟踪周期性支出
      </p>
      <button
        @click="openAddForm"
        class="mt-4 px-4 py-2 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
      >
        添加第一个订阅
      </button>
    </div>

    <!-- Form Modal / Slide-up Panel -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-300 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div v-if="showForm" class="fixed inset-0 z-[100] flex items-end md:items-center justify-center">
          <!-- Backdrop -->
          <div class="absolute inset-0 bg-black/40" @click="closeForm"></div>

          <!-- Panel -->
          <div class="relative w-full max-w-lg bg-white rounded-t-2xl md:rounded-2xl max-h-[85vh] overflow-y-auto shadow-xl">
            <!-- Header -->
            <div class="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center justify-between rounded-t-2xl z-10">
              <h2 class="text-base font-semibold text-[color:var(--color-text-primary)]">
                {{ editingId ? '编辑订阅' : '新增订阅' }}
              </h2>
              <button @click="closeForm" class="p-1 text-gray-400 hover:text-gray-600">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- Form Body -->
            <div class="p-5 space-y-4">
              <!-- Name -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">名称</label>
                <input
                  v-model="form.name"
                  type="text"
                  placeholder="如：Netflix、iCloud、会员"
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <!-- Amount -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">金额（元）</label>
                <div class="relative">
                  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">¥</span>
                  <input
                    v-model="form.amount"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    class="w-full pl-7 pr-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              <!-- Cycle -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">扣费周期</label>
                <div class="grid grid-cols-3 gap-2">
                  <button
                    v-for="(cfg, key) in cycleConfig"
                    :key="key"
                    @click="form.cycle = key as Subscription['cycle']"
                    class="py-2 rounded-lg text-xs font-medium transition-all border"
                    :class="form.cycle === key
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-[color:var(--color-border)] text-gray-500 hover:border-gray-300'"
                  >
                    {{ cfg.label }}
                  </button>
                </div>
              </div>

              <!-- Start Date -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">开始日期</label>
                <input
                  v-model="form.start_date"
                  type="date"
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <!-- Category -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">分类（可选）</label>
                <select
                  v-model="form.category_id"
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                >
                  <option :value="null">不指定</option>
                  <option v-for="cat in categories" :key="cat.id" :value="cat.id">
                    {{ cat.icon }} {{ cat.name }}
                  </option>
                </select>
              </div>

              <!-- Account -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">账户（可选）</label>
                <select
                  v-model="form.account_id"
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                >
                  <option :value="null">不指定</option>
                  <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                    {{ acc.name }}
                  </option>
                </select>
              </div>

              <!-- Reminder Days -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">提前提醒天数</label>
                <input
                  v-model.number="form.reminder_days"
                  type="number"
                  min="0"
                  max="30"
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <!-- Auto Record Toggle -->
              <div class="flex items-center justify-between">
                <div>
                  <label class="text-xs font-medium text-gray-600">自动记账</label>
                  <p class="text-[10px] text-gray-400 mt-0.5">到期自动生成交易记录</p>
                </div>
                <button
                  @click="form.auto_record = !form.auto_record"
                  class="relative w-10 h-5.5 rounded-full transition-colors"
                  :class="form.auto_record ? 'bg-blue-500' : 'bg-gray-200'"
                >
                  <span
                    class="absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform"
                    :class="form.auto_record ? 'translate-x-[18px]' : 'translate-x-0'"
                  ></span>
                </button>
              </div>

              <!-- Note -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1.5">备注（可选）</label>
                <textarea
                  v-model="form.note"
                  rows="2"
                  placeholder="添加备注..."
                  class="w-full px-3 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                ></textarea>
              </div>
            </div>

            <!-- Footer Buttons -->
            <div class="sticky bottom-0 bg-white border-t border-gray-100 px-5 py-4 flex gap-3">
              <button
                @click="closeForm"
                class="flex-1 py-2.5 border border-[color:var(--color-border)] rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                @click="saveSubscription"
                :disabled="formSaving"
                class="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {{ formSaving ? '保存中...' : (editingId ? '更新' : '保存') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
