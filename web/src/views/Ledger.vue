<script setup lang="ts">
import { ref, onMounted, computed, watch, onUnmounted, nextTick } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { Line, Doughnut } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, ArcElement, Tooltip, Legend, Filler,
} from 'chart.js'
import api from '@/api/index'
import type { Transaction } from '@/api/types'
import PageHeader from '@/components/ui/PageHeader.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import StatTile from '@/components/ui/StatTile.vue'
import Meter from '@/components/ui/Meter.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import EditTransactionModal from '@/components/EditTransactionModal.vue'
import { useChartColors, tone, CATEGORY_PALETTE, baseScales } from '@/utils/chart'
import { usePeriodStore } from '@/stores/period'
import { useLedgerStore } from '@/stores/ledger'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const ledger = useLedgerStore()

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend, Filler,
)

const { schemeTick } = useChartColors()

/* ── 周期 ──
   周期不再由账本页自己持有，而是读全局 period store：
   仪表面上那个控件是唯一的修改入口，账本页只跟随。
   否则会出现两处月份显示不一致，而记账的人恰恰最怕这个。       */
const period = usePeriodStore()
const year = computed(() => period.year)
const month = computed(() => period.month)

/** 仪表上换月后滚回顶部：换周期等于换了一本账，位置没有意义 */
/** 换月 = 换了一本账，去那个月自己的位置；没记过就回顶部 */
watch(() => period.current, () => {
  const saved = ledger.recall(scrollKeyNow.value)
  pendingScroll = saved > 0 ? saved : 0
  if (pendingScroll === 0) window.scrollTo({ top: 0, behavior: 'smooth' })
})

/* ── Tab ── */
const TABS = [
  { value: 'transactions', label: '流水' },
  { value: 'stats', label: '统计' },
]

/* ── 流水 ── */

/** tags 存的是 JSON 字符串（见 EditTransactionModal 的解析），直接渲染会显示成
 *  #["a","b"]。这里拆成数组，最多显示 2 个，多余的收敛为 +N。 */
function parseTags(raw?: string): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((t) => typeof t === 'string' && t.trim())
  } catch { /* 旧数据可能不是 JSON，按逗号兜底 */ }
  return raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
}
const visibleTags = (raw?: string) => {
  const list = parseTags(raw)
  return { first: list.slice(0, 2), more: Math.max(0, list.length - 2) }
}

/** 只有带时分秒的日期才显示时间，避免出现「餐饮 · 」这种悬空分隔符 */
const hasTime = (d: string) => (d?.length ?? 0) > 10

const transactions = ref<Transaction[]>([])
const txLoading = ref(false)
const txTotal = ref(0)
const txPage = ref(1)
const txPageSize = 20
const hasMore = computed(() => txPage.value * txPageSize < txTotal.value)

const keyword = computed({
  get: () => ledger.keyword,
  set: (v: string) => { ledger.keyword = v },
})
const filterType = computed({
  get: () => ledger.filterType,
  set: (v: string) => { ledger.filterType = v },
})
const activeTab = computed({
  get: () => ledger.activeTab,
  set: (v: 'transactions' | 'stats') => { ledger.activeTab = v },
})
const TYPE_FILTERS = [
  { value: '', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
]

const showEditModal = ref(false)
const editingTransaction = ref<Transaction | null>(null)
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

async function fetchTransactions(append = false) {
  txLoading.value = true
  try {
    const { start_date: startDate, end_date: endDate } = period.range

    const params: Record<string, any> = {
      page: txPage.value, page_size: txPageSize, start_date: startDate, end_date: endDate,
    }
    if (keyword.value) params.keyword = keyword.value
    if (filterType.value) params.type = filterType.value

    const { data } = await api.get('/transactions', { params })
    if (data.code === 0) {
      transactions.value = append ? [...transactions.value, ...data.data.items] : data.data.items
      txTotal.value = data.data.total
    }
  } catch { /* ignore */ } finally {
    txLoading.value = false
    // 每一页加载完都试一次：分页渲染完成高度才算数，否则会拿旧的 scrollHeight 判断
    nextTick(tryRestoreScroll)
  }
}

function handleSearch() {
  txPage.value = 1
  pendingScroll = 0
  window.scrollTo({ top: 0 })
  fetchTransactions()
}
function clearSearch() { keyword.value = ''; handleSearch() }

function setFilterType(t: string) {
  filterType.value = t
  txPage.value = 1
  pendingScroll = 0
  window.scrollTo({ top: 0 })
  fetchTransactions()
}

/* ── 滚动位置记忆 ─────────────────────────────────────
   账本是无限滚动的，所以「直接 scrollTo(记住的位置)」行不通：
   浏览器会把位置截断到当前已加载内容的高度。用户滚到第 3 页离开、
   回来只加载了第 1 页，结果落在一个不伦不类的位置——比不恢复更糟。

   改成记住一个「目标位置」：内容不够高就先补页，补完再试，
   直到能真正落到位。                              */
const scrollKeyNow = computed(() =>
  ledger.scrollKey(period.current, activeTab.value, filterType.value, keyword.value),
)
let pendingScroll: number | null = null

function saveScroll() {
  // 目标还没落到位时不要记，否则会把一个临时位置当成用户的位置存下来
  if (pendingScroll != null) return
  ledger.remember(scrollKeyNow.value, window.scrollY)
}

/**
 * 存位置必须发生在「导航开始时」，不能等卸载。
 *
 * 实测踩过的坑：原本写在 onUnmounted 里，但 router 会先把新页面滚到顶部
 * （scrollBehavior 返回 { top: 0 }）才卸载旧组件，于是 saveScroll 读到的
 * scrollY 已经是 0——等于永远存下 0。onBeforeRouteLeave 在 DOM 还是旧页
 * 的时候触发，才是唯一可靠时机。
 */
onBeforeRouteLeave(() => { saveScroll() })

function tryRestoreScroll() {
  if (pendingScroll == null) return
  const needed = pendingScroll + window.innerHeight
  if (document.documentElement.scrollHeight < needed) {
    if (hasMore.value) {
      // 正在加载说明「还有页在路上」，它的 finally 会再叫我一次；
      // 不能在这里认定到底了。写错这个判断的表现是：只补一页就停在半路。
      if (!txLoading.value) loadMore()
      return
    }
    // 真的没有更多了（筛选结果变少 / 到底了），接受现实地停在最底部
    window.scrollTo(0, document.documentElement.scrollHeight)
    pendingScroll = null
    return
  }
  window.scrollTo(0, pendingScroll)
  pendingScroll = null
}

function loadMore() {
  if (txLoading.value || !hasMore.value) return
  txPage.value++
  fetchTransactions(true)
}

/** 滚到底自动续页，不打断正在读账的人 */
function setupObserver() {
  observer?.disconnect()
  if (!sentinel.value) return
  observer = new IntersectionObserver(
    (entries) => { if (entries[0]?.isIntersecting) loadMore() },
    { rootMargin: '240px' },
  )
  observer.observe(sentinel.value)
}
onUnmounted(() => observer?.disconnect())


function handleEditSaved() {
  showEditModal.value = false
  editingTransaction.value = null
  txPage.value = 1
  fetchTransactions()
}

const grouped = computed(() => {
  const map: Record<string, Transaction[]> = {}
  for (const tx of transactions.value) (map[tx.date] ??= []).push(tx)
  return Object.entries(map).sort(([a], [b]) => b.localeCompare(a))
})

const dayExpense = (items: Transaction[]) =>
  items.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0)

function formatDate(d: string): string {
  const dt = new Date(d)
  return `${dt.getMonth() + 1}月${dt.getDate()}日 周${'日一二三四五六'[dt.getDay()]}`
}

/* ── 统计 ── */
const summary = ref<any>(null)
const categoryData = ref<any[]>([])
const trendData = ref<any[]>([])
const viewType = ref<'expense' | 'income'>('expense')

async function fetchSummary() {
  try {
    const { data } = await api.get('/stats/summary', { params: { year: year.value, month: month.value } })
    if (data.code === 0) summary.value = data.data
  } catch { /* ignore */ }
}
async function fetchCategory() {
  try {
    const { data } = await api.get('/stats/by-category', {
      params: { year: year.value, month: month.value, type: viewType.value },
    })
    if (data.code === 0) categoryData.value = data.data.items
  } catch { /* ignore */ }
}
async function fetchTrend() {
  try {
    const { data } = await api.get('/stats/trend', {
      params: { year: year.value, month: month.value, period: 'daily', type: viewType.value },
    })
    if (data.code === 0) trendData.value = data.data.items
  } catch { /* ignore */ }
}
const fetchStats = () => Promise.all([fetchSummary(), fetchCategory(), fetchTrend()])

const aiSummary = ref('')
const aiFullText = ref('')
const aiLoading = ref(false)
const aiExpanded = ref(false)
const aiGenerated = ref(false)

async function generateAiSummary() {
  aiLoading.value = true
  aiGenerated.value = false
  try {
    const { data } = await api.post('/stats/analysis', { type: 'spending', year: year.value, month: month.value })
    if (data.code === 0) {
      const text = data.data.analysis || data.data.content || ''
      const lines = text.split('\n').filter((l: string) => l.trim())
      aiSummary.value = lines[0] || '暂无分析结果'
      aiFullText.value = text
      aiGenerated.value = true
    }
  } catch { /* ignore */ } finally { aiLoading.value = false }
}

/* 图表：canvas 不认 CSS 变量，取计算值；配色方案变化时重算 */
const trendChartData = computed(() => {
  void schemeTick.value
  const main = viewType.value === 'expense' ? tone.expense : tone.income
  return {
    labels: trendData.value.map((d) => String(d.date).slice(8)),
    datasets: [{
      label: viewType.value === 'expense' ? '支出' : '收入',
      data: trendData.value.map((d) => d.total / 100),
      borderColor: main,
      backgroundColor: 'rgba(127,127,127,0.10)',
      fill: true, tension: 0.38, borderWidth: 1.75,
      pointRadius: 2, pointHoverRadius: 4, pointBackgroundColor: main, pointBorderWidth: 0,
    }],
  }
})

const trendChartOptions = computed(() => ({
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { displayColors: false } },
  scales: baseScales(),
}))

const doughnutChartData = computed(() => {
  void schemeTick.value
  return {
    labels: categoryData.value.map((c) => c.name),
    datasets: [{
      data: categoryData.value.map((c) => c.total / 100),
      backgroundColor: CATEGORY_PALETTE(),
      borderWidth: 0,
    }],
  }
})

const doughnutChartOptions = computed(() => ({
  responsive: true, maintainAspectRatio: false, cutout: '64%',
  plugins: { legend: { display: false }, tooltip: { displayColors: false } },
}))

/* ── 监听 ── */
watch([year, month], () => {
  txPage.value = 1
  activeTab.value === 'transactions' ? fetchTransactions() : fetchStats()
  aiGenerated.value = false; aiSummary.value = ''; aiFullText.value = ''; aiExpanded.value = false
})
watch(viewType, () => { fetchCategory(); fetchTrend() })
watch(activeTab, (tab) => {
  if (tab === 'transactions' && transactions.value.length === 0) fetchTransactions()
  else if (tab === 'stats' && !summary.value) fetchStats()
  // 两个 tab 的内容高度完全不同，位置不能互相继承
  pendingScroll = ledger.recall(scrollKeyNow.value)
  if (pendingScroll === 0) window.scrollTo({ top: 0, behavior: 'smooth' })
  nextTick(tryRestoreScroll)
})
watch(filterType, () => nextTick(setupObserver))

onMounted(async () => {
  // 从别处带筛选条件进来：仪表上的「本月支出」读数就链到这里
  const qType = route.query.type
  if (typeof qType === 'string' && TYPE_FILTERS.some(o => o.value === qType)) {
    filterType.value = qType
    router.replace({ query: {} })
  }

  // 先记下目标位置，再开始拉数据：顺序反了就拿不到旧位置
  const saved = ledger.recall(scrollKeyNow.value)
  if (saved > 0) pendingScroll = saved

  await fetchTransactions()
  nextTick(() => { setupObserver(); tryRestoreScroll() })
})
</script>

<template>
  <div>
    <PageHeader title="账本" :subtitle="`${period.label} 共 ${txTotal} 笔记录`">
      <template #meta>
        <!-- 周期控件长在仪表面上，这里不重复放第二个月份 -->
        <span v-if="!period.isCurrent" class="ledger-period-hint">
          正在看历史月份
        </span>
      </template>
    </PageHeader>

    <SegmentedControl v-model="activeTab" :options="TABS" class="mb-5" />

    <!-- ═══ 流水 ═══ -->
    <template v-if="activeTab === 'transactions'">
      <!-- 筛选栏 -->
      <div class="surface p-3 mb-4 space-y-3">
        <div class="flex gap-1.5">
          <button
            v-for="opt in TYPE_FILTERS"
            :key="opt.value"
            class="chip"
            :class="{ 'chip-active': filterType === opt.value }"
            @click="setFilterType(opt.value)"
          >{{ opt.label }}</button>
        </div>
        <div class="relative">
          <AppIcon name="search" :size="15" class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                   style="color: var(--color-ink-4)" />
          <input
            id="page-search"
            v-model="keyword"
            type="search"
            class="field !pl-8 !pr-8"
            placeholder="搜索描述、分类、标签"
            @keyup.enter="handleSearch"
            @keydown.esc="clearSearch"
          />
          <button
            v-if="keyword"
            class="absolute right-2 top-1/2 -translate-y-1/2 p-1"
            aria-label="清空搜索"
            @click="clearSearch"
          >
            <AppIcon name="close" :size="13" style="color: var(--color-ink-4)" />
          </button>
        </div>
      </div>

      <!-- 加载 / 空 / 列表 -->
      <div v-if="txLoading && !transactions.length">
        <div class="sheet p-4"><Skeleton variant="rows" :lines="6" /></div>
      </div>

      <EmptyState
        v-else-if="!transactions.length"
        ruled
        icon="ledger"
        :title="keyword || filterType ? '没有符合条件的记录' : `${year}年${month}月还没有记账`"
        :description="keyword || filterType ? '换个关键词，或把筛选切回「全部」。' : '记一笔，这里就有账了。'"
      >
        <router-link v-if="!keyword && !filterType" to="/" class="btn btn-primary btn-sm">
          <AppIcon name="pen" :size="13" />去记一笔
        </router-link>
      </EmptyState>

      <div v-else class="space-y-5">
        <section v-for="[date, items] in grouped" :key="date">
          <div class="day-head">
            <span class="amt">{{ formatDate(date) }}</span>
            <span class="flex items-center gap-1.5">
              <span class="text-[0.625rem]" style="color: var(--color-ink-4)">支出</span>
              <Money :value="dayExpense(items)" sign="none" size="sm" tone="muted" />
            </span>
          </div>

          <div class="sheet">
            <SheetRow
              v-for="tx in items"
              :key="tx.id"
              clickable
              @click="editingTransaction = tx; showEditModal = true"
            >
              <span class="tx-icon" aria-hidden="true">{{ tx.category_icon || '📦' }}</span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="text-[0.8125rem] truncate" style="color: var(--color-ink-1)">
                    {{ tx.description || tx.category_name || '未分类' }}
                  </span>
                  <template v-if="tx.tags">
                    <span v-for="t in visibleTags(tx.tags).first" :key="t" class="badge shrink-0">#{{ t }}</span>
                    <span v-if="visibleTags(tx.tags).more" class="badge shrink-0">
                      +{{ visibleTags(tx.tags).more }}
                    </span>
                  </template>
                </span>
                <span class="block text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
                  <span v-if="tx.category_name">{{ tx.category_name }}</span>
                  <template v-if="tx.type === 'transfer' && tx.target_account_name">
                    <span v-if="tx.category_name"> · </span>→ {{ tx.target_account_name }}
                  </template>
                  <template v-if="tx.account_name && tx.type !== 'transfer'">
                    <span v-if="tx.category_name"> · </span>{{ tx.account_name }}
                  </template>
                  <template v-if="hasTime(tx.date)">
                    <span v-if="tx.category_name"> · </span>
                    <span class="hidden sm:inline amt">{{ tx.date.slice(11, 16) }}</span>
                  </template>
                </span>
              </span>
              <Money :value="tx.amount" :tone="tx.type === 'expense' ? 'expense' : tx.type === 'income' ? 'income' : 'info'" />
            </SheetRow>
          </div>
        </section>

        <!-- 自动续页哨兵 -->
        <div ref="sentinel" class="h-px" aria-hidden="true" />
        <p v-if="txLoading && transactions.length" class="text-center text-[0.6875rem] py-3" style="color: var(--color-ink-4)">
          正在载入更多…
        </p>
        <p v-else-if="!hasMore" class="text-center text-[0.6875rem] py-3" style="color: var(--color-ink-4)">
          本月共 {{ txTotal }} 笔，已全部显示
        </p>
      </div>
    </template>

    <!-- ═══ 统计 ═══ -->
    <template v-else>
      <!-- 本月三指标 -->
      <div v-if="summary" class="grid grid-cols-3 gap-2.5 mb-5">
        <StatTile label="支出" :delta="summary.expense_change" delta-invert>
          <Money :value="summary.expense" sign="none" size="md" tone="expense" />
        </StatTile>
        <StatTile label="收入" :delta="summary.income_change">
          <Money :value="summary.income" sign="none" size="md" tone="income" />
        </StatTile>
        <StatTile label="结余" :hint="`${summary.transaction_count ?? 0} 笔`">
          <Money :value="summary.balance" size="md" :tone="summary.balance >= 0 ? 'neutral' : 'expense'" />
        </StatTile>
      </div>

      <!-- 支出 / 收入 -->
      <div class="flex items-center gap-2 mb-4">
        <SegmentedControl
          v-model="viewType"
          :options="[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }]"
          size="sm"
        />
      </div>

      <!-- 趋势 -->
      <section class="surface p-4 mb-4">
        <LedgerLabel>{{ viewType === 'expense' ? '支出' : '收入' }}趋势</LedgerLabel>
        <div v-if="trendData.length" class="h-44 -ml-1">
          <Line :data="trendChartData" :options="trendChartOptions" />
        </div>
        <EmptyState v-else compact icon="chart" title="暂无趋势数据" />
      </section>

      <!-- 分类 -->
      <section v-if="categoryData.length" class="surface p-4 mb-4">
        <LedgerLabel>{{ viewType === 'expense' ? '支出' : '收入' }}分类</LedgerLabel>
        <div class="grid sm:grid-cols-[11rem_minmax(0,1fr)] gap-4 items-center">
          <div class="h-40"><Doughnut :data="doughnutChartData" :options="doughnutChartOptions" /></div>
          <ul class="space-y-2">
            <li v-for="c in categoryData" :key="c.id" class="flex items-center gap-2">
              <span class="tx-icon !w-5 !h-5 !text-xs" aria-hidden="true">{{ c.icon }}</span>
              <span class="text-xs flex-1 truncate" style="color: var(--color-ink-2)">{{ c.name }}</span>
              <Meter
                :percent="c.percent"
                :tone="viewType === 'expense' ? 'danger' : 'income'"
                class="!w-16"
              />
              <Money :value="c.total" sign="none" size="sm" tone="muted" class="amt" />
              <span class="text-[0.625rem] amt w-9 text-right" style="color: var(--color-ink-4)">{{ c.percent }}%</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- AI 总结 -->
      <section class="ai-card">
        <span class="ai-bar" aria-hidden="true" />
        <div class="p-4">
          <div class="flex items-center gap-1.5 mb-2.5">
            <AppIcon name="spark" :size="14" />
            <span class="text-[0.8125rem] font-semibold" style="color: var(--color-ink-1)">AI 总结</span>
          </div>

          <template v-if="!aiGenerated && !aiLoading">
            <p class="text-xs mb-3" style="color: var(--color-ink-3)">
              让 AI 读一遍 {{ year }}年{{month}}月 的账，说说钱花在哪了。
            </p>
            <button class="btn btn-outline btn-block" @click="generateAiSummary">生成 AI 总结</button>
          </template>

          <div v-else-if="aiLoading" class="flex items-center gap-2 py-3">
            <span class="inline-block w-3.5 h-3.5 rounded-full border-2 border-rule-strong border-t-ink-1 animate-spin" />
            <span class="text-xs" style="color: var(--color-ink-3)">AI 正在读你的账…</span>
          </div>

          <template v-else>
            <p class="text-sm leading-relaxed" style="color: var(--color-ink-1)">{{ aiSummary }}</p>
            <div v-if="aiExpanded" class="mt-3 pt-3 whitespace-pre-wrap text-xs leading-relaxed"
                 style="border-top: 1px solid var(--color-rule-faint); color: var(--color-ink-2)">
              {{ aiFullText }}
            </div>
            <button class="act mt-2" @click="aiExpanded = !aiExpanded">
              {{ aiExpanded ? '收起' : '查看详细分析' }}
            </button>
          </template>
        </div>
      </section>
    </template>
  </div>

  <EditTransactionModal
    :show="showEditModal"
    :transaction="editingTransaction"
    @close="showEditModal = false"
    @saved="handleEditSaved"
  />
</template>

<style scoped>
.day-head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.375rem 0.125rem;
  font-size: 0.6875rem;
  color: var(--color-ink-3);
  background: var(--color-paper);
}
@media (min-width: 1024px) { .day-head { top: 0.5rem; } }

.ai-card {
  position: relative;
  display: flex;
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.ai-bar { width: 3px; background: var(--color-action); flex-shrink: 0; }
</style>
