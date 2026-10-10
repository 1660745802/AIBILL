<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getAssetsOverview } from '@/api/assets'
import type { AssetOverview } from '@/api/assets'
import { useToast } from '@/composables/useToast'
import PageHeader from '@/components/ui/PageHeader.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useClusterStore } from '@/stores/cluster'
import AccountsPanel from '@/components/AccountsPanel.vue'
import { useInvestmentNav } from '@/composables/useInvestmentNav'

const toast = useToast()
const cluster = useClusterStore()
const { refreshInvestmentNav } = useInvestmentNav()
const loading = ref(true)
const overview = ref<AssetOverview | null>(null)


async function loadData() {
  loading.value = true
  try {
    // 账户设置只用到账户级元数据（额度/账单日），dashboard 不带，仍走 /assets/overview。
    const o = await getAssetsOverview()
    overview.value = o.data.data
  } catch { toast.error('加载失败') }
  finally { loading.value = false }
}




/** 传给子组件的账户列表（永远存在的真源） */
const accountList = computed(() =>
  (overview.value?.accounts ?? []).map((a) => ({
    id: a.id, name: a.name, asset_type: a.asset_type || 'liquid', icon: a.icon,
  })),
)
const accountsTotal = computed(() => overview.value?.accounts.length ?? 0)
/** 理财账户 —— 决定要不要显示「投资」入口（同 nav.ts 的 needsInvestment） */
const investmentAccounts = computed(() =>
  (overview.value?.accounts ?? []).filter((a) => a.asset_type === 'investment'),
)



/** 任一子组件写入后：重算读数 + 刷新仪表 */
async function onDataChanged() {
  cluster.loadPortfolio()
  // 类型可能刚被改过（面板里改类型也走这个回调）→ 侧栏「投资」入口要跟上，强刷绕缓存
  await refreshInvestmentNav(true)
  await loadData()
}

onMounted(loadData)
</script>

<template>
  <div class="pb-20 md:pb-4">
    <PageHeader title="资产" :subtitle="`${accountsTotal} 个账户 · 余额与类型都在下面一处改`" />

    <div v-if="loading" class="stack">
      <Skeleton variant="block" height="5rem" />
      <Skeleton variant="block" height="9rem" />
      <Skeleton variant="block" height="11rem" />
    </div>

    <template v-else-if="overview">
      <div class="stack">
        <!-- ── 各账户余额（每日） ──
             理财账户的余额框填的是**现金**，持仓市值在下面自动显示 + 点进投资页。
             （「资产 = 汇总 / 投资 = 明细」：这一页每账户只给一个数。） -->
        <!-- 一个列表管两件事：填余额 + 展开改类型。
             以前这里是两块（各账户余额 / 账户设置）列同一批账户两遍。 -->
        <AccountsPanel :accounts="accountList" @changed="onDataChanged" />

        <!-- 理财账户 → 投资页的入口。
             这是 UI-DESIGN §6.5 承诺的那个入口；之前全仓没有任何
             `RouterLink to="/investments"`，新用户只能靠「我的」页的
             一处过滤不一致意外进去。 -->
        <RouterLink
          v-if="investmentAccounts.length"
          to="/investments"
          class="sheet sheet-row sheet-row-click"
        >
          <AppIcon name="trendUp" :size="16" class="text-ink-3" />
          <span class="flex-1 text-[0.8125rem]" style="color: var(--color-ink-1)">
            投资持仓与盈亏
            <span class="text-[0.6875rem]" style="color: var(--color-ink-3)">
              （{{ investmentAccounts.map((a: any) => a.name).join('、') }}）
            </span>
          </span>
          <AppIcon name="chevronRight" :size="14" class="chev-link" />
        </RouterLink>

      </div>
    </template>
  </div>
</template>

<style scoped>
@media (min-width: 640px) { .t3-grid { grid-template-columns: repeat(4, 1fr); } }
</style>
