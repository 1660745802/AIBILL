<script setup lang="ts">
/**
 * 被拦样本 tab —— 「这条本该拦 / 本该放」的内容在这里被 review（契约 §11.6）。
 *
 * **两条通道分开看**（§11.1 / §11.2）：
 *   · `客户端采样`（`/admin/capture-samples`）—— 客户端**本地丢**（零证据）的样本；
 *   · `服务端预筛挡下`（`admin/filter-samples`）—— 客户端**转发**过来、但被服务端预筛
 *     （`classifyNotification` / `verifyParsed`）挡下的原文。归表把 F 类 5 条改成了 forward，
 *     没有这一侧就只能看到 `client_filter_stats` 的计数，回答不了「拦对了吗」。
 *
 * 两侧共用 days / channel / package 筛选与分页；`blocked_by` 只属于采样、`reason` 只属于预筛
 * （切通道时清掉对面的值，否则会把不属于该端点的参数发过去）。
 *
 * 标注（`is_bill|not_bill`）只有采样侧有：预筛样本尚无 label 列，先只读。两者都**只落人工意见**：
 * **不写账、不调 AI、不回推客户端**；「其实是账」的整理仍走 `rules.json` 发布流程。
 *
 * module 自持筛选、标注提交与读失败态。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { formatLocalTime } from '@/utils/date'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminPager from './AdminPager.vue'
import AdminStat from './AdminStat.vue'

const toast = useToast()

/** 文本/原文只渲染前这么多字（真实长度用 text_len 标注） */
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

const source = ref<Source>('capture')
const samplesFilter = ref({ days: '7', channel: '', blocked_by: '', reason: '', package: '' })
const page = ref(1)
const pageSize = 20

const stats = ref<
  | null
  | {
      items: Array<Record<string, any>>
      summary: { total: number; by_package: SummaryRow[] } & Partial<Record<'by_blocked_by' | 'by_reason', SummaryRow[]>>
      pagination: { page: number; page_size: number; total: number; total_pages: number }
    }
  | null
>(null)
const loading = ref(false)
/** 正在提交标注的样本 id（按行禁用按钮，避免连点写错条） */
const submitting = ref<null | number>(null)
const error = ref(false)

onMounted(() => fetchSamples())

async function fetchSamples() {
  loading.value = true
  try {
    const isCapture = source.value === 'capture'
    const f = samplesFilter.value
    const params = new URLSearchParams({
      days: f.days,
      page: String(page.value),
      page_size: String(pageSize),
    })
    if (f.channel) params.set('channel', f.channel)
    if (f.package) params.set('package', f.package)
    if (isCapture ? f.blocked_by : f.reason) {
      params.set(isCapture ? 'blocked_by' : 'reason', isCapture ? f.blocked_by : f.reason)
    }
    const url = isCapture ? `/admin/capture-samples?${params}` : `/admin/filter-samples?${params}`
    const { data } = await api.get(url)
    stats.value = data.code === 0 ? data.data : null
    error.value = false
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

/* 筛选变化 = 回到第 1 页：否则停在第 3 页再改筛选会拿到空页，
   被误读成「这个规则一条样本都没有」（假空态）。 */
function refetch() {
  page.value = 1
  fetchSamples()
}

function gotoPage(p: number) {
  page.value = p
  fetchSamples()
}

/**
 * 切来源：清掉**所有随来源变化的筛选**再拉。
 *
 * `blocked_by` / `reason` 各自专属（采样侧是「拦截点」，预筛侧是「预筛理由」）；
 * `package` 虽然两侧都有，但**取值域不同**——采样的 `package` 可能是 `sms:<号码>`，
 * 预筛的 `source_package` 是包名。不过滤掉就会「下拉显示空值（选项里没有它）+ 列表按看不见的值过滤 → 假空态」，
 * 看上去就是「切了没数据 / 切换很奇怪」。
 */
function switchSource(v: string) {
  source.value = (v as Source) === 'prefilter' ? 'prefilter' : 'capture'
  samplesFilter.value.blocked_by = ''
  samplesFilter.value.reason = ''
  samplesFilter.value.package = ''
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

/** 超长只渲染前 N 字 + 余量：本页默认返回原文，长页滚屏会把面板撑到不可用 */
function previewText(text: string | null | undefined): string {
  const t = text ?? ''
  return t.length > TEXT_PREVIEW ? `${t.slice(0, TEXT_PREVIEW)}…` : t
}

function textLen(s: Record<string, any>): number {
  return typeof s.text_len === 'number' ? s.text_len : (s.text?.length ?? 0)
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

  <div class="flex items-center justify-between gap-3 flex-wrap">
    <span class="ledger-label ledger-label-solid">被拦样本</span>
    <SegmentedControl :options="SOURCE_OPTIONS" :model-value="source" size="sm" @update:model-value="switchSource" />
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
      <select v-if="source === 'capture'" v-model="samplesFilter.blocked_by" class="field w-auto" @change="refetch">
        <option value="">全部拦截点</option>
        <option v-for="r in stats?.summary.by_blocked_by ?? []" :key="r.key ?? 'null'" :value="r.key ?? ''">
          {{ r.key }}（{{ r.count }}）
        </option>
      </select>
      <select v-else v-model="samplesFilter.reason" class="field w-auto" @change="refetch">
        <option value="">全部预筛理由</option>
        <option v-for="r in stats?.summary.by_reason ?? []" :key="r.key ?? 'null'" :value="r.key ?? ''">
          {{ r.key }}（{{ r.count }}）
        </option>
      </select>
      <select v-model="samplesFilter.package" class="field w-auto" @change="refetch">
        <option value="">全部包名</option>
        <option v-for="p in stats?.summary.by_package ?? []" :key="p.key ?? 'null'" :value="p.key ?? ''">
          {{ p.key ?? '未知包名' }}（{{ p.count }}）
        </option>
      </select>
    </div>
  </div>

  <p v-if="source === 'capture'" class="text-xs text-ink-3 leading-relaxed">
    客户端<b>在本地丢掉</b>、没走到服务端预筛的通知/页面（零证据类：自身通知 / 空文本 / 结构早退 /
    A11Y 白名单外…）。P1 默认带<b>原文</b>（§11.5）。标注只落人工意见：<b>不写账、不调 AI、不回推客户端</b>。
    「是账」= 这条规则误杀（per-rule 误杀率的分子）；整理进 <code>rules.json</code> 仍走发布流程。
  </p>
  <p v-else class="text-xs text-ink-3 leading-relaxed">
    客户端<b>转发</b>过来、但被<b>服务端预筛</b>挡下的原文（<code>forward</code> 通道，落
    <code>ai_parse_filters</code>）。归表把 F 类 5 条改成 forward 后，没有这一侧就只有计数、
    回答不了「拦对了吗」。这一侧暂<b>只读</b>（无 label 列）；同样<b>不写账、不调 AI、不回推客户端</b>。
  </p>

  <div v-if="loading" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="!stats"
    icon="search"
    :title="source === 'capture' ? '读不到拦截样本' : '读不到预筛样本'"
    description="接口失败，或窗口内没有客户端上报的样本。这不是「没有数据」。"
    compact
  />
  <template v-else>
    <section>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat :value="stats.summary.total" tone="action">
          {{ source === 'capture' ? '窗口内样本' : '窗口内预筛拦下' }}
        </AdminStat>
      </div>
      <div v-if="(source === 'capture' ? stats.summary.by_blocked_by : stats.summary.by_reason)?.length" class="sheet mt-3">
        <div class="sheet-row">
          <span class="ledger-label">{{ source === 'capture' ? '拦截点 Top' : '预筛理由 Top' }}</span>
        </div>
        <div
          v-for="r in (source === 'capture' ? stats.summary.by_blocked_by : stats.summary.by_reason)!.slice(0, 8)"
          :key="r.key ?? 'null'"
          class="sheet-row"
        >
          <span class="mono text-xs text-ink-1 truncate flex-1">{{ r.key ?? '（无理由）' }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ r.count }} 条</span>
        </div>
      </div>
      <div v-if="stats.summary.by_package.length" class="sheet mt-3">
        <div class="sheet-row"><span class="ledger-label">包名 Top</span></div>
        <div v-for="p in stats.summary.by_package.slice(0, 8)" :key="p.key ?? 'null'" class="sheet-row">
          <span class="text-xs text-ink-1 truncate flex-1">{{ p.key ?? '未知包名' }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ p.count }} 条</span>
        </div>
      </div>
    </section>

    <EmptyState
      v-if="stats.items.length === 0"
      icon="check"
      :title="source === 'capture' ? '窗口内没有拦截样本' : '窗口内没有预筛拦下的样本'"
      compact
    />

    <!-- 客户端采样：原文 + 标注 -->
    <div v-else-if="source === 'capture'" class="space-y-2">
      <div v-for="s in stats.items" :key="s.id" class="surface p-3">
        <div class="flex items-center gap-2 flex-wrap text-xs text-ink-3">
          <span class="amt">#{{ s.id }}</span>
          <span class="truncate max-w-40">{{ s.package }}</span>
          <span class="badge">{{ s.channel }}</span>
          <span v-if="s.kind === 'a11y_page'" class="badge badge-info">整页</span>
          <span class="badge badge-ink">{{ s.stage }}</span>
          <code class="mono text-ink-2 truncate max-w-64">{{ s.blocked_by }}</code>
          <span v-if="s.tier != null" class="amt">tier {{ s.tier }}</span>
          <span class="amt">{{ formatLocalTime(s.received_at ?? s.created_at) }}</span>
          <span class="badge" :class="labelClass(s.label)">{{ labelText(s.label) }}</span>
        </div>
        <div v-if="s.text" class="text-sm text-ink-1 mt-2 mono break-words whitespace-pre-wrap">
          {{ previewText(s.text) }}
        </div>
        <div v-if="textLen(s) > TEXT_PREVIEW || !s.text" class="text-xs text-ink-4 mt-1 amt">
          共 {{ textLen(s) }} 字<template v-if="s.text && textLen(s) > TEXT_PREVIEW">（已截断）</template>
        </div>
        <div class="flex items-center gap-2 mt-2 flex-wrap">
          <button class="btn btn-sm" :disabled="submitting === s.id" @click="labelSample(s.id, 'is_bill')">是账</button>
          <button class="btn btn-outline btn-sm" :disabled="submitting === s.id" @click="labelSample(s.id, 'not_bill')">不是账</button>
        </div>
      </div>
    </div>

    <!-- 服务端预筛挡下：原文 + reasons + tier + duration + source_package（只读） -->
    <div v-else class="space-y-2">
      <div v-for="s in stats.items" :key="s.id" class="surface p-3">
        <div class="flex items-center gap-2 flex-wrap text-xs text-ink-3">
          <span class="amt">#{{ s.id }}</span>
          <span class="truncate max-w-40">{{ s.source_package ?? '未知包名' }}</span>
          <span v-if="s.channel" class="badge">{{ s.channel }}</span>
          <span class="badge badge-ink">{{ s.stage }}</span>
          <span v-if="s.tier != null" class="amt">tier {{ s.tier }}</span>
          <span class="amt">{{ s.duration_ms }}ms</span>
          <span class="amt">{{ formatLocalTime(s.created_at) }}</span>
        </div>
        <div v-if="parseReasons(s.reasons).length" class="flex items-center gap-1.5 flex-wrap mt-2">
          <span v-for="r in parseReasons(s.reasons)" :key="r" class="badge badge-warn mono">{{ r }}</span>
        </div>
        <div v-if="s.text_len" class="text-sm text-ink-1 mt-2 mono break-words whitespace-pre-wrap">
          {{ previewText(s.raw_input) }}
        </div>
        <div v-if="(s.text_len ?? 0) > TEXT_PREVIEW" class="text-xs text-ink-4 mt-1 amt">
          共 {{ s.text_len }} 字（已截断）
        </div>
      </div>
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
