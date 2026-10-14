<script setup lang="ts">
/**
 * 被拦样本 tab —— 「这条被拦，拦对了吗」在这里 review（契约 §11.6）。
 *
 * **两条来源**（同一页切换）：
 *   · `客户端采样`（`/admin/capture-samples`）—— 客户端**本地丢**的样本（零证据 / 归表 sample）；
 *   · `服务端预筛挡下`（`/admin/filter-samples`）—— 客户端**转发**过来、被服务端预筛挡下的原文。
 *
 * 版式：头（标题 + 来源切换 ‖ 筛选）→ 说明 → **汇总条**（总数 + 点一下即过滤的 Top chips）
 * → **统一列表**（原文在前、元信息在后、标注在底）→ 分页。两侧共用一套卡片。
 *
 * 标注（`is_bill|not_bill`）只有采样侧有（预筛样本无 label 列，只读）；都**只落人工意见**：
 * 不写账、不调 AI、不回推客户端。module 自持筛选、标注与读失败态。
 */
import { ref, computed, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { formatLocalTime } from '@/utils/date'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminPager from './AdminPager.vue'

const toast = useToast()

/** 收起时只渲染这么多字（真实长度用 text_len 标注，可展开看全文） */
const TEXT_PREVIEW = 200

type Source = 'capture' | 'prefilter'
const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'capture', label: '客户端采样' },
  { value: 'prefilter', label: '服务端预筛挡下' },
]

interface SummaryRow {
  key: string | null
  count: number
}
interface SampleStats {
  items: Array<Record<string, any>>
  summary: { total: number; by_package: SummaryRow[] } & Partial<Record<'by_blocked_by' | 'by_reason', SummaryRow[]>>
  pagination: { page: number; page_size: number; total: number; total_pages: number }
}

const source = ref<Source>('capture')
const samplesFilter = ref({ days: '7', channel: '', blocked_by: '', reason: '', package: '' })
const page = ref(1)
const pageSize = 20

const stats = ref<SampleStats | null>(null)
const loading = ref(false)
const error = ref(false)
/** 正在提交标注的样本 id（按行禁用，避免连点写错条） */
const submitting = ref<null | number>(null)
/** 已展开全文的样本 id（默认收起，长原文不撑爆页面） */
const expanded = ref<Set<number>>(new Set())

const isCapture = computed(() => source.value === 'capture')
const facetLabel = computed(() => (isCapture.value ? '拦截点' : '预筛理由'))
const facetRows = computed<SummaryRow[]>(() =>
  isCapture.value ? (stats.value?.summary.by_blocked_by ?? []) : (stats.value?.summary.by_reason ?? []),
)
const packageRows = computed<SummaryRow[]>(() => stats.value?.summary.by_package ?? [])
/** 当前生效的 facet 值（拦截点 / 预筛理由），用于高亮对应 chip */
const facetValue = computed(() => (isCapture.value ? samplesFilter.value.blocked_by : samplesFilter.value.reason))

onMounted(() => fetchSamples())

async function fetchSamples() {
  loading.value = true
  try {
    const f = samplesFilter.value
    const params = new URLSearchParams({ days: f.days, page: String(page.value), page_size: String(pageSize) })
    if (f.channel) params.set('channel', f.channel)
    if (f.package) params.set('package', f.package)
    if (isCapture.value ? f.blocked_by : f.reason) {
      params.set(isCapture.value ? 'blocked_by' : 'reason', isCapture.value ? f.blocked_by : f.reason)
    }
    const url = isCapture.value ? `/admin/capture-samples?${params}` : `/admin/filter-samples?${params}`
    const { data } = await api.get(url)
    stats.value = data.code === 0 ? data.data : null
    error.value = false
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

/* 筛选变化 = 回到第 1 页：否则停在第 3 页再改筛选会拿到空页，被误读成「这个规则一条样本都没有」。 */
function refetch() {
  page.value = 1
  fetchSamples()
}

function gotoPage(p: number) {
  page.value = p
  fetchSamples()
}

/**
 * 切来源：清掉**所有随来源变化的筛选**再拉。`blocked_by` / `reason` 各自专属；
 * `package` 取值域两侧不同（采样的可能是 `sms:<号码>`、预筛的是包名），留着会查不到且下拉显示空值。
 */
function switchSource(v: string) {
  source.value = (v as Source) === 'prefilter' ? 'prefilter' : 'capture'
  samplesFilter.value.blocked_by = ''
  samplesFilter.value.reason = ''
  samplesFilter.value.package = ''
  expanded.value = new Set()
  refetch()
}

/** 点 Top chip = 设/清该维筛选（再点一次清掉） */
function toggleFacet(key: string) {
  if (isCapture.value) {
    samplesFilter.value.blocked_by = samplesFilter.value.blocked_by === key ? '' : key
  } else {
    samplesFilter.value.reason = samplesFilter.value.reason === key ? '' : key
  }
  refetch()
}

function togglePackage(key: string) {
  samplesFilter.value.package = samplesFilter.value.package === key ? '' : key
  refetch()
}

/** 只写标注（`is_bill` / `not_bill`）；幂等，重复提交也返回成功 */
async function labelSample(id: number, label: 'is_bill' | 'not_bill') {
  submitting.value = id
  try {
    await api.post(`/admin/capture-samples/${id}/label`, { label })
    toast.success(label === 'is_bill' ? '已标注「是账」' : '已标注「不是账」')
    await fetchSamples()
  } catch {
    /* 拦截器已提示 */
  } finally {
    submitting.value = null
  }
}

function toggleExpand(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 两侧原文列名不同：采样是 `text`，预筛是 `raw_input` */
function itemText(s: Record<string, any>): string {
  return ((isCapture.value ? s.text : s.raw_input) as string | null | undefined) ?? ''
}

function textLen(s: Record<string, any>): number {
  return typeof s.text_len === 'number' ? s.text_len : itemText(s).length
}

function previewText(s: Record<string, any>): string {
  const t = itemText(s)
  return t.length > TEXT_PREVIEW && !expanded.value.has(s.id) ? `${t.slice(0, TEXT_PREVIEW)}…` : t
}

/** `reasons` 是 JSON 数组列；坏 JSON 当空，不让一行数据把面板整块渲染打挂 */
function parseReasons(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function labelClass(label: string | null | undefined): string {
  if (label === 'is_bill') return 'badge badge-income'
  if (label === 'not_bill') return 'badge badge-ink'
  return 'badge badge-warn'
}

function labelText(label: string | null | undefined): string {
  return label === 'is_bill' ? '是账' : label === 'not_bill' ? '不是账' : '未裁决'
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchSamples" />

  <!-- 头：左 = 标题 + **来源切换**（整页视图开关，不与筛选平级）；右 = 筛选 -->
  <div class="flex items-start justify-between gap-3 flex-wrap">
    <div class="flex items-center gap-3 flex-wrap">
      <span class="ledger-label ledger-label-solid">被拦样本</span>
      <SegmentedControl :options="SOURCE_OPTIONS" :model-value="source" size="sm" @update:model-value="switchSource" />
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <select v-model="samplesFilter.days" class="field w-auto" @change="refetch">
        <option value="1">今天</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
        <option value="90">近 90 天</option>
      </select>
      <select v-model="samplesFilter.channel" class="field w-auto" @change="refetch">
        <option value="">全部渠道</option>
        <option value="nls">nls</option>
        <option value="sms">sms</option>
        <option value="a11y">a11y</option>
      </select>
      <!-- 拦截点 / 预筛理由：选项随来源与窗口变，**必须固定宽度**（否则选项多少会改变 select 宽度→整行跳） -->
      <select v-if="isCapture" v-model="samplesFilter.blocked_by" class="field w-56 truncate" @change="refetch">
        <option value="">全部拦截点</option>
        <option v-for="r in facetRows" :key="r.key ?? 'null'" :value="r.key ?? ''">{{ r.key }}（{{ r.count }}）</option>
      </select>
      <select v-else v-model="samplesFilter.reason" class="field w-56 truncate" @change="refetch">
        <option value="">全部预筛理由</option>
        <option v-for="r in facetRows" :key="r.key ?? 'null'" :value="r.key ?? ''">{{ r.key }}（{{ r.count }}）</option>
      </select>
      <select v-model="samplesFilter.package" class="field w-56 truncate" @change="refetch">
        <option value="">全部包名</option>
        <option v-for="p in packageRows" :key="p.key ?? 'null'" :value="p.key ?? ''">
          {{ p.key ?? '未知包名' }}（{{ p.count }}）
        </option>
      </select>
    </div>
  </div>

  <p class="text-xs text-ink-3 leading-relaxed mt-2 mb-3">
    <template v-if="isCapture">
      客户端<b>在本地丢掉</b>、没走到服务端预筛的通知 / 页面（零证据类 + 归表 <code class="mono">sample</code> 的规则）。
    </template>
    <template v-else>
      客户端<b>转发</b>过来、被<b>服务端预筛</b>挡下的原文（<code class="mono">forward</code> 通道）。这一侧只读。
    </template>
    两者都 <b>不写账、不调 AI、不回推客户端</b>；「是账」= 该规则误杀，整理进 <code class="mono">rules.json</code> 仍走发布流程。
  </p>

  <div v-if="!stats && loading" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="!stats"
    icon="search"
    :title="isCapture ? '读不到拦截样本' : '读不到预筛样本'"
    description="接口失败，或窗口内没有样本。这不是「没有数据」。"
    compact
  />
  <template v-else>
    <!-- 重新拉取时**保留内容**（只提示一下），不塔成「加载中…」：否则切来源/改筛选整块高度会跳 -->
    <div v-if="loading" class="text-right text-xs text-ink-4 mb-1">更新中…</div>

    <!-- 汇总条：总数 + Top（点选即过滤） -->
    <section class="surface p-3 space-y-2">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-sm text-ink-1">窗口内 <b class="amt">{{ stats.summary.total }}</b> 条</span>
        <span v-if="facetValue" class="text-xs text-ink-3">
          已过滤 <code class="mono">{{ facetValue }}</code> ·
          <button type="button" class="act" @click="toggleFacet(facetValue)">清掉</button>
        </span>
        <span v-if="samplesFilter.package" class="text-xs text-ink-3">
          包名 <code class="mono">{{ samplesFilter.package }}</code> ·
          <button type="button" class="act" @click="togglePackage(samplesFilter.package)">清掉</button>
        </span>
      </div>
      <div class="grid md:grid-cols-2 gap-x-6 gap-y-2">
        <div class="min-w-0">
          <div class="ledger-label mb-1.5">{{ facetLabel }} Top（点选过滤）</div>
          <div v-if="facetRows.length" class="flex items-center gap-1.5 flex-wrap">
            <button
              v-for="r in facetRows.slice(0, 10)"
              :key="r.key ?? 'null'"
              type="button"
              class="chip"
              :class="facetValue === (r.key ?? '') ? 'chip-active' : ''"
              @click="toggleFacet(r.key ?? '')"
            >{{ r.key ?? '（无理由）' }}&nbsp;<span class="amt">{{ r.count }}</span></button>
          </div>
          <div v-else class="text-xs text-ink-4">窗口内没有</div>
        </div>
        <div class="min-w-0">
          <div class="ledger-label mb-1.5">包名 Top（点选过滤）</div>
          <div v-if="packageRows.length" class="flex items-center gap-1.5 flex-wrap">
            <button
              v-for="p in packageRows.slice(0, 10)"
              :key="p.key ?? 'null'"
              type="button"
              class="chip"
              :class="samplesFilter.package === (p.key ?? '') ? 'chip-active' : ''"
              @click="togglePackage(p.key ?? '')"
            >{{ p.key ?? '未知包名' }}&nbsp;<span class="amt">{{ p.count }}</span></button>
          </div>
          <div v-else class="text-xs text-ink-4">窗口内没有</div>
        </div>
      </div>
    </section>

    <!-- 列表：原文在前、元信息在后、标注在底（两侧共用一套卡片） -->
    <EmptyState
      v-if="stats.items.length === 0"
      icon="check"
      :title="isCapture ? '窗口内没有拦截样本' : '窗口内没有预筛拦下的样本'"
      compact
    />
    <div v-else class="space-y-2 mt-3">
      <article v-for="s in stats.items" :key="s.id" class="surface p-3 space-y-2">
        <!-- 原文（主） -->
        <div v-if="itemText(s)" class="text-sm text-ink-1 mono break-words whitespace-pre-wrap">
          {{ previewText(s) }}
          <button v-if="textLen(s) > TEXT_PREVIEW" type="button" class="act ml-1 whitespace-nowrap" @click="toggleExpand(s.id)">
            {{ expanded.has(s.id) ? '收起' : `展开（共 ${textLen(s)} 字）` }}
          </button>
        </div>
        <div v-else class="text-xs text-ink-4">（无原文）</div>

        <!-- 元信息（次） -->
        <div class="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs text-ink-3">
          <span class="amt">#{{ s.id }}</span>
          <span class="truncate max-w-48">{{ isCapture ? s.package : (s.source_package ?? '未知包名') }}</span>
          <span v-if="s.channel" class="badge">{{ s.channel }}</span>
          <span v-if="s.kind === 'a11y_page'" class="badge badge-info">整页</span>
          <span class="badge badge-ink">{{ s.stage }}</span>
          <code v-if="isCapture" class="mono text-ink-2 truncate max-w-64">{{ s.blocked_by }}</code>
          <span v-for="r in parseReasons(s.reasons)" :key="r" class="badge badge-warn mono">{{ r }}</span>
          <span v-if="s.tier != null" class="amt">tier {{ s.tier }}</span>
          <span v-if="s.duration_ms != null" class="amt">{{ s.duration_ms }}ms</span>
          <span class="amt">{{ formatLocalTime(s.received_at ?? s.created_at) }}</span>
        </div>

        <!-- 动作：采样侧可裁决；预筛侧只读 -->
        <div class="flex items-center gap-2 flex-wrap pt-0.5">
          <template v-if="isCapture">
            <button class="btn btn-sm" :disabled="submitting === s.id" @click="labelSample(s.id, 'is_bill')">是账</button>
            <button class="btn btn-outline btn-sm" :disabled="submitting === s.id" @click="labelSample(s.id, 'not_bill')">不是账</button>
            <span class="badge" :class="labelClass(s.label)">{{ labelText(s.label) }}</span>
          </template>
          <span v-else class="text-xs text-ink-4">只读（预筛样本无 label 列）</span>
        </div>
      </article>
    </div>

    <AdminPager
      v-if="stats.pagination.total_pages > 1"
      :page="stats.pagination.page"
      :total="stats.pagination.total"
      :total-pages="stats.pagination.total_pages"
      @change="gotoPage"
    />
  </template>
</template>
