<script setup lang="ts">
/**
 * 被拦样本 tab —— 客户端**本地丢掉**的内容在这里被 review（契约 docs/API.md 附录 C §11.6）。
 *
 * 与「未解析裁决」的分工：那边是**服务端**判失败（AI 不可用，无 `parsed_items`），
 * 这边是**客户端**在本地丢掉的样本（P1 默认带原文，§11.5）。两者都只落人工意见：
 * **不写账、不调 AI、不回推客户端**；「其实是账」的后续整理仍走 `rules.json` 发布流程。
 *
 * 标注是**规则闭环的数据来源**（§11.6）：per-rule 精度（命中次数 × 标注）= 误杀率 → 调归表。
 *
 * module 自持筛选、标注提交与读失败态。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { formatLocalTime } from '@/utils/date'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminPager from './AdminPager.vue'
import AdminStat from './AdminStat.vue'

const toast = useToast()

/** 列表里的 text 只渲染前这么多字（真实长度用 text_len 标注） */
const TEXT_PREVIEW = 200

const samplesFilter = ref({ days: '7', channel: '', blocked_by: '', package: '' })
const page = ref(1)
const pageSize = 20

const stats = ref<null | {
  items: Array<Record<string, any>>
  summary: { total: number; by_blocked_by: Array<{ key: string; count: number }>; by_package: Array<{ key: string; count: number }> }
  pagination: { page: number; page_size: number; total: number; total_pages: number }
}>(null)
const loading = ref(false)
/** 正在提交标注的样本 id（按行禁用按钮，避免连点写错条） */
const submitting = ref<null | number>(null)
const error = ref(false)

onMounted(() => fetchSamples())

async function fetchSamples() {
  loading.value = true
  try {
    const params = new URLSearchParams({
      days: samplesFilter.value.days,
      page: String(page.value),
      page_size: String(pageSize),
    })
    if (samplesFilter.value.channel) params.set('channel', samplesFilter.value.channel)
    if (samplesFilter.value.blocked_by) params.set('blocked_by', samplesFilter.value.blocked_by)
    if (samplesFilter.value.package) params.set('package', samplesFilter.value.package)
    const { data } = await api.get(`/admin/capture-samples?${params.toString()}`)
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
      <select v-model="samplesFilter.blocked_by" class="field w-auto" @change="refetch">
        <option value="">全部拦截点</option>
        <option v-for="r in stats?.summary.by_blocked_by ?? []" :key="r.key" :value="r.key">
          {{ r.key }}（{{ r.count }}）
        </option>
      </select>
      <select v-model="samplesFilter.package" class="field w-auto" @change="refetch">
        <option value="">全部包名</option>
        <option v-for="p in stats?.summary.by_package ?? []" :key="p.key" :value="p.key">
          {{ p.key }}（{{ p.count }}）
        </option>
      </select>
    </div>
  </div>

  <p class="text-xs text-ink-3 leading-relaxed">
    这些是客户端<b>在本地丢掉</b>、没走到服务端预筛的通知/页面（P1 默认带<b>原文</b>，§11.5）。
    标注只落人工意见：<b>不写账、不调 AI、不回推客户端</b>。
    「是账」= 这条规则误杀（per-rule 误杀率的分子）；整理进
    <code>rules.json</code> 仍走发布流程，不允许在线改判据。
  </p>

  <div v-if="loading" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="!stats"
    icon="search"
    title="读不到拦截样本"
    description="接口失败，或窗口内没有客户端上报的样本。这不是「没有数据」。"
    compact
  />
  <template v-else>
    <section>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat :value="stats.summary.total" tone="action">窗口内样本</AdminStat>
      </div>
      <div v-if="stats.summary.by_blocked_by.length" class="sheet mt-3">
        <div class="sheet-row"><span class="ledger-label">拦截点 Top</span></div>
        <div v-for="r in stats.summary.by_blocked_by.slice(0, 8)" :key="r.key" class="sheet-row">
          <span class="mono text-xs text-ink-1 truncate flex-1">{{ r.key }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ r.count }} 条</span>
        </div>
      </div>
      <div v-if="stats.summary.by_package.length" class="sheet mt-3">
        <div class="sheet-row"><span class="ledger-label">包名 Top</span></div>
        <div v-for="p in stats.summary.by_package.slice(0, 8)" :key="p.key" class="sheet-row">
          <span class="text-xs text-ink-1 truncate flex-1">{{ p.key }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ p.count }} 条</span>
        </div>
      </div>
    </section>

    <EmptyState
      v-if="stats.items.length === 0"
      icon="check"
      title="窗口内没有拦截样本"
      compact
    />
    <div v-else class="space-y-2">
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
          <button
            class="btn btn-sm"
            :disabled="submitting === s.id"
            @click="labelSample(s.id, 'is_bill')"
          >是账</button>
          <button
            class="btn btn-outline btn-sm"
            :disabled="submitting === s.id"
            @click="labelSample(s.id, 'not_bill')"
          >不是账</button>
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
