<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getAssetsOverview, updateAccountAsset } from '@/api/assets'
import type { AssetOverview } from '@/api/assets'
import { useToast } from '@/composables/useToast'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import StatTile from '@/components/ui/StatTile.vue'
import Money from '@/components/ui/Money.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useClusterStore } from '@/stores/cluster'

const toast = useToast()
const cluster = useClusterStore()
const loading = ref(true)
const overview = ref<AssetOverview | null>(null)
const editingAccount = ref<number | null>(null)
const editForm = ref<any>({})

const assetTypeLabels: Record<string, string> = {
  liquid: '活期', savings: '定期', investment: '理财投资',
  credit: '信用卡', loan: '贷款', property: '不动产', other: '其他',
}

async function loadData() {
  loading.value = true
  try {
    // 这一页要的是账户级字段（额度/账单日），dashboard 不带，所以仍走
    // /assets/overview；仪表读数则由 store 自行拉取，两边不会打同一个接口。
    const o = await getAssetsOverview()
    overview.value = o.data.data
  } catch { toast.error('加载失败') }
  finally { loading.value = false }
}

/** 账户总数，给页头一句人话 */
const accountsTotal = computed(() => overview.value?.accounts.length ?? 0)

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
    toast.success('已更新'); editingAccount.value = null
    await loadData()
    // 改完账户余额，顶部仪表的净资产读数必须跟着变
    cluster.load(true)
  }
  catch { toast.error('更新失败') }
}

const hasAccounts = computed(() => (overview.value?.accounts.length ?? 0) > 0)

onMounted(loadData)
</script>

<template>
  <div class="pb-20 md:pb-4">
    <PageHeader title="账户" :subtitle="`${accountsTotal} 个账户 · 展开任意行可改类型与额度`" />

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
        <!-- 净资产读数与资产构成已经在常驻仪表上，这里不重复。
             这一页的任务是把账户管好，所以上来就给总资产/总负债和账户列表。 -->
        <div class="grid grid-cols-2 gap-3">
          <StatTile label="总资产">
            <Money :value="overview.total_assets" size="lg" tone="income" sign="none" />
          </StatTile>
          <StatTile label="总负债">
            <Money :value="overview.total_liabilities" size="lg" tone="expense" />
          </StatTile>
        </div>

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
