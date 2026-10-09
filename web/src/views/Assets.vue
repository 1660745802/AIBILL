<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getAssetsOverview, updateAccountAsset } from '@/api/assets'
import type { AssetOverview } from '@/api/assets'
import { Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, ArcElement, Tooltip, Legend } from 'chart.js'
import { useToast } from '@/composables/useToast'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import StatTile from '@/components/ui/StatTile.vue'
import Money from '@/components/ui/Money.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

ChartJS.register(CategoryScale, LinearScale, PointElement, ArcElement, Tooltip, Legend)

const toast = useToast()
const loading = ref(true)
const overview = ref<AssetOverview | null>(null)
const editingAccount = ref<number | null>(null)
const editForm = ref<any>({})

const assetTypeLabels: Record<string, string> = {
  liquid: '活期', savings: '定期', investment: '理财投资',
  credit: '信用卡', loan: '贷款', property: '不动产', other: '其他',
}

// 读取 CSS 变量，保证图表配色走设计系统语义色（深色模式自动跟随）
// 注意：canvas 不认 CSS 变量/var()，必须取计算值；也不认 color-mix()，淡色填充用 rgba。
function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#14171a'
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#14171a'
}

// 分布环形的分段色：围绕语义色（收/支/警/信息/墨）循环，而非彩虹硬编码
const distPalette = computed(() => [
  cssVar('--color-income'),
  cssVar('--color-info'),
  cssVar('--color-warn'),
  cssVar('--color-expense'),
  cssVar('--color-ink-1'),
  cssVar('--color-ink-3'),
  cssVar('--color-ink-4'),
])

async function loadData() {
  loading.value = true
  try {
    const o = await getAssetsOverview()
    overview.value = o.data.data
  } catch { toast.error('加载失败') }
  finally { loading.value = false }
}

const pieData = computed(() => {
  if (!overview.value) return { labels: [], datasets: [] }
  const types = overview.value.by_type.filter(t => t.total > 0)
  const palette = distPalette.value
  return {
    labels: types.map(t => assetTypeLabels[t.type] || t.type),
    datasets: [{
      data: types.map(t => t.total / 100),
      backgroundColor: types.map((_, i) => palette[i % palette.length]),
      borderWidth: 0,
    }],
  }
})

// 环形图例：色块 / 名称 / 金额 / 占比
const pieLegend = computed(() => {
  if (!overview.value) return []
  const types = overview.value.by_type.filter(t => t.total > 0)
  const sum = types.reduce((s, t) => s + t.total, 0) || 1
  const palette = distPalette.value
  return types.map((t, i) => ({
    label: assetTypeLabels[t.type] || t.type,
    total: t.total,
    color: palette[i % palette.length],
    pct: Math.round((t.total / sum) * 100),
  }))
})

// 去掉网格线与图例边框，坐标文字走墨色次级
const pieOpts = computed(() => ({
  responsive: true, maintainAspectRatio: false, cutout: '62%',
  plugins: { legend: { display: false }, tooltip: { displayColors: false } },
}))

const groupedAccounts = computed(() => {
  if (!overview.value) return {} as Record<string, AssetOverview['accounts']>
  const groups: Record<string, AssetOverview['accounts']> = {}
  for (const acc of overview.value.accounts) {
    const type = acc.asset_type || 'liquid'
    if (!groups[type]) groups[type] = []
    groups[type].push(acc)
  }
  return groups
})

function groupSubtotal(accounts: AssetOverview['accounts']): number {
  return accounts.reduce((s, a) => s + (a.balance || 0), 0)
}

function startEdit(acc: any) {
  if (editingAccount.value === acc.id) { editingAccount.value = null; return }
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

const hasAccounts = computed(() => (overview.value?.accounts.length ?? 0) > 0)

onMounted(loadData)
</script>

<template>
  <div class="pb-20 md:pb-4">
    <PageHeader title="资产全景" subtitle="各账户余额与净资产" />

    <!-- 加载态 -->
    <div v-if="loading" class="stack">
      <div class="ledger-block"><div class="lb-inner"><Skeleton variant="lines" :lines="3" /></div></div>
      <div class="grid grid-cols-2 gap-3">
        <Skeleton variant="block" height="4.5rem" />
        <Skeleton variant="block" height="4.5rem" />
      </div>
      <Skeleton variant="block" height="11rem" />
    </div>

    <template v-else-if="overview">
      <div class="stack">
        <!-- 净资产主块：paper-ruled 纸纹底 + hero 金额 -->
        <div class="ledger-block paper-ruled">
          <div class="lb-inner">
            <LedgerLabel>净资产</LedgerLabel>
            <Money
              :value="overview.net_worth"
              size="hero"
              :tone="overview.net_worth < 0 ? 'expense' : 'neutral'"
              sign="none"
            />
          </div>
        </div>

        <!-- 资产 / 负债两格 -->
        <div class="grid grid-cols-2 gap-3">
          <StatTile label="总资产">
            <Money :value="overview.total_assets" size="lg" tone="income" sign="none" />
          </StatTile>
          <StatTile label="总负债">
            <Money :value="overview.total_liabilities" size="lg" tone="expense" />
          </StatTile>
        </div>

        <!-- 资产分布 -->
        <section>
          <LedgerLabel>资产分布</LedgerLabel>
          <div v-if="pieLegend.length > 0" class="surface p-4">
            <div class="h-52"><Doughnut :data="pieData" :options="pieOpts" /></div>
            <div class="mt-3 space-y-1.5">
              <div v-for="row in pieLegend" :key="row.label" class="flex items-center gap-2 text-xs">
                <span class="w-2.5 h-2.5 rounded-xs shrink-0" :style="{ background: row.color }" />
                <span class="text-ink-2 truncate flex-1">{{ row.label }}</span>
                <Money :value="row.total" size="sm" tone="neutral" sign="none" />
                <span class="text-ink-4 w-9 text-right">{{ row.pct }}%</span>
              </div>
            </div>
          </div>
          <EmptyState v-else icon="pie" title="还没有资产分布" description="添加账户并填写余额后，这里会按类型展示你的资产构成。" :ruled="true" :compact="true" />
        </section>

        <!-- 账户按类型分组：每组一个 sheet，组头浅底 + 小计 -->
        <section>
          <LedgerLabel>账户明细</LedgerLabel>
          <template v-if="hasAccounts">
            <div class="space-y-3">
              <div v-for="(accounts, type) in groupedAccounts" :key="type" class="sheet">
                <!-- 组头：浅底 + 类型名 + 小计 -->
                <div class="flex items-center justify-between px-3.5 py-2 bg-paper-sunk border-b border-rule-faint">
                  <span class="text-xs font-semibold text-ink-2">{{ assetTypeLabels[type as string] || type }}</span>
                  <Money :value="groupSubtotal(accounts)" size="sm" tone="muted" sign="none" />
                </div>
                <template v-for="acc in accounts" :key="acc.id">
                  <button
                    class="sheet-row sheet-row-click"
                    :class="editingAccount === acc.id ? 'sheet-row-active' : ''"
                    @click="startEdit(acc)"
                  >
                    <span class="tx-icon">{{ acc.icon }}</span>
                    <span class="text-sm font-medium text-ink-1 truncate flex-1 text-left">{{ acc.name }}</span>
                    <Money
                      :value="acc.balance"
                      size="md"
                      :tone="acc.balance >= 0 ? 'neutral' : 'expense'"
                      sign="none"
                    />
                    <AppIcon
                      :name="editingAccount === acc.id ? 'chevronUp' : 'chevronDown'"
                      :size="15"
                      class="text-ink-4"
                    />
                  </button>

                  <!-- 行内展开编辑：纸下沉底 -->
                  <div v-if="editingAccount === acc.id" class="px-3.5 py-3 bg-paper-sunk border-t border-rule-faint">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label class="field-label">账户类型</label>
                        <select v-model="editForm.asset_type" class="field">
                          <option v-for="(label, key) in assetTypeLabels" :key="key" :value="key">{{ label }}</option>
                        </select>
                      </div>
                      <div v-if="editForm.asset_type === 'credit'">
                        <label class="field-label">额度（元）</label>
                        <input v-model.number="editForm.credit_limit" type="number" class="field amt" />
                      </div>
                    </div>
                    <div class="flex justify-end gap-2 mt-3">
                      <button @click.stop="editingAccount = null" class="btn btn-quiet btn-sm">取消</button>
                      <button @click.stop="saveEdit" class="btn btn-primary btn-sm">保存</button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <EmptyState
            v-else
            icon="wallet"
            title="还没有账户"
            description="去设置里添加账户，记录初始余额后，资产全景就会算出你的净资产。"
            :ruled="true"
          >
            <RouterLink to="/settings" class="btn btn-primary btn-sm">添加账户</RouterLink>
          </EmptyState>
        </section>
      </div>
    </template>
  </div>
</template>
