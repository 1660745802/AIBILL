<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getAssetsOverview, getAssetsTrend, createSnapshot, updateAccountAsset } from '@/api/assets'
import type { AssetOverview, TrendPoint } from '@/api/assets'
import { Line, Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, ArcElement } from 'chart.js'
import { useToast } from '@/composables/useToast'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, ArcElement)

const toast = useToast()
const loading = ref(true)
const overview = ref<AssetOverview | null>(null)
const trend = ref<TrendPoint[]>([])
const editingAccount = ref<number | null>(null)
const editForm = ref<any>({})

const assetTypeLabels: Record<string, string> = {
  liquid: '活期', savings: '定期', investment: '理财投资',
  credit: '信用卡', loan: '贷款', property: '不动产', other: '其他',
}

const assetTypeColors: Record<string, string> = {
  liquid: '#059669', savings: '#3b82f6', investment: '#8b5cf6',
  credit: '#f59e0b', loan: '#dc2626', property: '#6366f1', other: '#6b7280',
}

function fmt(cents: number): string {
  const abs = Math.abs(cents)
  const str = (abs / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-¥${str}` : `¥${str}`
}

async function loadData() {
  loading.value = true
  try {
    const [o, t] = await Promise.all([getAssetsOverview(), getAssetsTrend(6)])
    overview.value = o.data.data
    trend.value = t.data.data.trend
  } catch { toast.error('加载失败') }
  finally { loading.value = false }
}

async function handleSnapshot() {
  try {
    const res = await createSnapshot()
    toast.success(res.data.message)
    await loadData()
  } catch { toast.error('快照失败') }
}

const pieData = computed(() => {
  if (!overview.value) return { labels: [], datasets: [] }
  const types = overview.value.by_type.filter(t => t.total > 0)
  return {
    labels: types.map(t => assetTypeLabels[t.type] || t.type),
    datasets: [{ data: types.map(t => t.total / 100), backgroundColor: types.map(t => assetTypeColors[t.type] || '#6b7280'), borderWidth: 0 }],
  }
})

const trendData = computed(() => ({
  labels: trend.value.map(t => t.snapshot_date.slice(5)),
  datasets: [{
    label: '净资产', data: trend.value.map(t => t.net_worth / 100),
    borderColor: '#4f46e5', backgroundColor: 'rgba(79, 70, 229, 0.06)',
    fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#4f46e5',
  }],
}))

const chartOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v: any) => `¥${v.toLocaleString()}` } } } }
const pieOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' as const, labels: { boxWidth: 10, font: { size: 11 } } } } }

const groupedAccounts = computed(() => {
  if (!overview.value) return {}
  const groups: Record<string, typeof overview.value.accounts> = {}
  for (const acc of overview.value.accounts) {
    const type = acc.asset_type || 'liquid'
    if (!groups[type]) groups[type] = []
    groups[type].push(acc)
  }
  return groups
})

function startEdit(acc: any) {
  editingAccount.value = acc.id
  editForm.value = { asset_type: acc.asset_type || 'liquid', credit_limit: (acc.credit_limit || 0) / 100, billing_day: acc.billing_day || 0, due_day: acc.due_day || 0, note: acc.note || '' }
}

async function saveEdit() {
  if (!editingAccount.value) return
  try {
    const payload = { ...editForm.value }
    if (payload.credit_limit) payload.credit_limit = Math.round(payload.credit_limit * 100)
    await updateAccountAsset(editingAccount.value, payload)
    toast.success('已更新'); editingAccount.value = null; await loadData()
  }
  catch { toast.error('更新失败') }
}

onMounted(loadData)
</script>

<template>
  <div class="pb-20 md:pb-4">
    <!-- Header -->
    <div class="flex items-center justify-between mb-5">
      <div>
        <h1 class="page-title">资产全景</h1>
        <p class="page-subtitle">追踪你的净资产变化</p>
      </div>
      <button @click="handleSnapshot" class="btn-secondary text-xs">📸 记录快照</button>
    </div>

    <div v-if="loading" class="space-y-4 animate-pulse">
      <div class="h-24 rounded-xl" style="background: var(--color-border-light)"></div>
      <div class="h-48 rounded-xl" style="background: var(--color-border-light)"></div>
    </div>

    <template v-else-if="overview">
      <!-- 净资产摘要 -->
      <div class="grid grid-cols-3 gap-3 mb-5">
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">总资产</p>
          <p class="text-base font-semibold amount-number amount-income">{{ fmt(overview.total_assets) }}</p>
        </div>
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">总负债</p>
          <p class="text-base font-semibold amount-number amount-expense">{{ fmt(overview.total_liabilities) }}</p>
        </div>
        <div class="card text-center">
          <p class="text-[11px] mb-1" style="color: var(--color-text-muted)">净资产</p>
          <p class="text-base font-semibold amount-number amount-balance">{{ fmt(overview.net_worth) }}</p>
        </div>
      </div>

      <!-- 图表 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div class="card" v-if="pieData.labels.length > 0">
          <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">资产分布</h3>
          <div class="h-44"><Doughnut :data="pieData" :options="pieOpts" /></div>
        </div>
        <div class="card">
          <h3 class="text-sm font-medium mb-3" style="color: var(--color-text-primary)">净资产趋势</h3>
          <div class="h-44" v-if="trend.length > 1"><Line :data="trendData" :options="chartOpts" /></div>
          <div v-else class="h-44 flex items-center justify-center text-sm" style="color: var(--color-text-muted)">
            快照不足，请定期记录
          </div>
        </div>
      </div>

      <!-- 账户列表 -->
      <div class="space-y-3">
        <div v-for="(accounts, type) in groupedAccounts" :key="type" class="card !p-0 overflow-hidden">
          <div class="px-4 py-2.5" style="background: var(--color-sidebar-bg); border-bottom: 1px solid var(--color-border-light)">
            <span class="text-xs font-medium" style="color: var(--color-text-secondary)">{{ assetTypeLabels[type as string] || type }}</span>
          </div>
          <div class="divide-y" style="border-color: var(--color-border-light)">
            <div v-for="acc in accounts" :key="acc.id" class="px-4 py-3">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <span class="text-base">{{ acc.icon }}</span>
                  <span class="text-sm font-medium" style="color: var(--color-text-primary)">{{ acc.name }}</span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-sm font-medium amount-number" :class="acc.balance >= 0 ? '' : 'amount-expense'">{{ fmt(acc.balance) }}</span>
                  <button @click="startEdit(acc)" class="text-[11px]" style="color: var(--color-primary-600)">编辑</button>
                </div>
              </div>
              <!-- 编辑 -->
              <div v-if="editingAccount === acc.id" class="mt-3 p-3 rounded-lg space-y-2" style="background: var(--color-sidebar-bg)">
                <div class="flex items-center gap-2">
                  <label class="text-[11px] w-14" style="color: var(--color-text-muted)">类型</label>
                  <select v-model="editForm.asset_type" class="flex-1 text-sm border rounded-md px-2 py-1" style="border-color: var(--color-border)">
                    <option v-for="(label, key) in assetTypeLabels" :key="key" :value="key">{{ label }}</option>
                  </select>
                </div>
                <div v-if="editForm.asset_type === 'credit'" class="flex items-center gap-2">
                  <label class="text-[11px] w-14" style="color: var(--color-text-muted)">额度(元)</label>
                  <input v-model.number="editForm.credit_limit" type="number" class="flex-1 text-sm border rounded-md px-2 py-1" style="border-color: var(--color-border)" />
                </div>
                <div class="flex gap-2 justify-end">
                  <button @click="editingAccount = null" class="text-xs px-3 py-1" style="color: var(--color-text-muted)">取消</button>
                  <button @click="saveEdit" class="btn-primary text-xs !py-1 !px-3">保存</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
