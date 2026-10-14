<script setup lang="ts">
/**
 * 解析质量 tab —— AI 解析统计 + 逐条日志 + 解析详情弹窗。
 *
 * module 自持统计、日志分页与筛选、详情弹窗；`statusLabel/statusBadge` 等展示映射也只在这里
 * （原先散在 Admin.vue 的 script 顶部，被质量 tab 与详情弹窗共用）。读失败态自带。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { formatLocalTime } from '@/utils/date'
import BaseModal from '@/components/ui/BaseModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminStat from './AdminStat.vue'
import AdminPager from './AdminPager.vue'

const parseStats = ref<any>(null)
const parseLogs = ref<any[]>([])
const parseLogsPagination = ref({ page: 1, page_size: 20, total: 0, total_pages: 0 })
const parseLogsFilter = ref({ status: '', days: '30' })
const showParseDetail = ref<any>(null)
const loadingParseLogs = ref(false)
const error = ref(false)

onMounted(() => { fetchParseStats(); fetchParseLogs(1) })

async function fetchParseStats() {
  try {
    const { data } = await api.get('/admin/ai-parse-stats', {
      params: { days: parseLogsFilter.value.days },
    })
    if (data.code === 0) parseStats.value = data.data
    error.value = false
  } catch {
    error.value = true
  }
}

async function fetchParseLogs(page = 1) {
  loadingParseLogs.value = true
  try {
    const params: any = {
      page,
      page_size: parseLogsPagination.value.page_size,
      days: parseLogsFilter.value.days,
    }
    if (parseLogsFilter.value.status) params.status = parseLogsFilter.value.status
    const { data } = await api.get('/admin/ai-parse-logs', { params })
    if (data.code === 0) {
      // 兜底 pagination：管理面板恰恰是「后端出问题时第一个要看的页面」，
      // 响应少一个字段就整页崩掉，等于在最需要它的时候罢工。
      parseLogs.value = data.data.items ?? []
      parseLogsPagination.value = { ...parseLogsPagination.value, ...(data.data.pagination ?? {}) }
    }
  } catch {
    error.value = true
  }
  finally { loadingParseLogs.value = false }
}

function viewParseDetail(log: any) {
  showParseDetail.value = log
}

function closeParseDetail() {
  showParseDetail.value = null
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const PARSE_STATUS: Record<string, { label: string; chipActive: string; badge: string }> = {
  success: { label: '成功', chipActive: 'qa-chip-income', badge: 'badge-income' },
  empty: { label: '空结果', chipActive: 'qa-chip-warn', badge: 'badge-warn' },
  error: { label: '错误', chipActive: 'qa-chip-expense', badge: 'badge-expense' },
  timeout: { label: '超时', chipActive: 'qa-chip-warn', badge: 'badge-warn' },
}

function statusLabel(status: string): string {
  return PARSE_STATUS[status]?.label || status
}

function statusBadge(status: string): string {
  return PARSE_STATUS[status]?.badge || 'badge'
}

function retry(): void {
  error.value = false
  fetchParseStats()
  fetchParseLogs(parseLogsPagination.value.page || 1)
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="retry" />

  <div class="flex items-center justify-between gap-3 mb-3">
    <span class="ledger-label ledger-label-solid">AI 解析质量</span>
    <select
      v-model="parseLogsFilter.days"
      class="field w-auto"
      @change="fetchParseStats(); fetchParseLogs(1)"
    >
      <option value="7">近 7 天</option>
      <option value="30">近 30 天</option>
      <option value="90">近 90 天</option>
      <option value="365">近一年</option>
    </select>
  </div>

  <!-- 指标格 -->
  <div v-if="parseStats" class="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
    <AdminStat :value="parseStats.overview.total" tone="action">总调用</AdminStat>
    <AdminStat :value="`${parseStats.overview.success_rate}%`" tone="income">成功率</AdminStat>
    <AdminStat :value="formatDuration(parseStats.overview.avg_duration_ms)" tone="info">平均耗时</AdminStat>
  </div>

  <!-- 服务端预筛（被规则挡下、根本没调模型）——查看本页“空结果率”时必须与它一起看 -->
  <section v-if="parseStats && parseStats.prefilter" class="mt-5">
    <div class="ledger-label mb-3">服务端预筛（挡下即不调模型）</div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStat :value="parseStats.prefilter.total" tone="action">挡下总数</AdminStat>
      <AdminStat :value="parseStats.prefilter.inbound" tone="income">入站（调模型前）</AdminStat>
      <AdminStat :value="parseStats.prefilter.outbound" tone="info">出站（模型结果后）</AdminStat>
      <AdminStat :value="parseStats.prefilter.perDay" tone="warn">日均挡下</AdminStat>
    </div>
    <div class="flex items-center justify-between mt-2 mb-3 text-xs text-ink-3">
      <span>入站预筛是纯字符串匹配，判定耗时中位 {{ parseStats.prefilter.medianMs }}ms / 最大 {{ parseStats.prefilter.maxMs }}ms</span>
      <span>覆盖 {{ parseStats.prefilter.days }} 天</span>
    </div>
    <div v-if="parseStats.prefilter.byReason?.length" class="sheet">
      <div v-for="r in parseStats.prefilter.byReason" :key="r.reason" class="sheet-row">
        <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.reason }}</span>
        <span class="text-sm text-ink-1 amt">{{ r.count }}</span>
      </div>
    </div>
  </section>

  <!-- AI 可用性（migration 022）——客户端把失败移出用户视野后，这里是唯一能发现「AI 挂了」的地方 -->
  <section v-if="parseStats && parseStats.overview" class="mt-5">
    <div class="ledger-label mb-3">AI 可用性（失败可观测）</div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStat :value="`${parseStats.overview.unavailable_rate}%`" tone="warn">不可用率（{{ parseStats.overview.unavailable_count }} 次）</AdminStat>
      <AdminStat :value="`${parseStats.overview.not_a_bill_rate}%`" tone="info">判非账（{{ parseStats.overview.not_a_bill_count }} 次·非故障）</AdminStat>
      <AdminStat :value="parseStats.overview.retry_rescued" tone="income">重试救回（共重试 {{ parseStats.overview.retried_count }}）</AdminStat>
      <AdminStat :value="parseStats.overview.success_count" tone="action">解析成功</AdminStat>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
      <div v-if="parseStats.by_failure_code?.length" class="sheet">
        <div class="sheet-row"><span class="ledger-label">失败原因（failure_code）</span></div>
        <div v-for="r in parseStats.by_failure_code" :key="r.failure_code" class="sheet-row">
          <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.failure_code }}</span>
          <span class="text-sm text-ink-1 amt">{{ r.count }}</span>
        </div>
      </div>
      <div v-if="parseStats.by_channel?.length" class="sheet">
        <div class="sheet-row"><span class="ledger-label">按渠道（老包无 channel 归 unknown）</span></div>
        <div v-for="c in parseStats.by_channel" :key="c.channel" class="sheet-row">
          <span class="flex-1 text-xs text-ink-1">{{ c.channel }}</span>
          <span class="text-xs text-ink-3 amt">不可用 {{ c.unavailable_count }}/{{ c.total }}（{{ c.unavailable_rate }}%）</span>
        </div>
      </div>
    </div>
  </section>

  <!-- 状态筛选 chip -->
  <div class="scroll-x flex gap-2 mb-3 pb-1">
    <button
      type="button"
      class="chip shrink-0"
      :class="parseLogsFilter.status === '' ? 'chip-active' : ''"
      @click="parseLogsFilter.status = ''; fetchParseLogs(1)"
    >全部</button>
    <button
      type="button"
      class="chip shrink-0"
      :class="parseLogsFilter.status === 'success' ? 'qa-chip-income' : ''"
      @click="parseLogsFilter.status = 'success'; fetchParseLogs(1)"
    >成功</button>
    <button
      type="button"
      class="chip shrink-0"
      :class="parseLogsFilter.status === 'empty' ? 'qa-chip-warn' : ''"
      @click="parseLogsFilter.status = 'empty'; fetchParseLogs(1)"
    >空结果</button>
    <button
      type="button"
      class="chip shrink-0"
      :class="parseLogsFilter.status === 'error' ? 'qa-chip-expense' : ''"
      @click="parseLogsFilter.status = 'error'; fetchParseLogs(1)"
    >错误</button>
    <button
      type="button"
      class="chip shrink-0"
      :class="parseLogsFilter.status === 'timeout' ? 'qa-chip-warn' : ''"
      @click="parseLogsFilter.status = 'timeout'; fetchParseLogs(1)"
    >超时</button>
  </div>

  <!-- 日志列表 -->
  <div v-if="loadingParseLogs" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="parseLogs.length === 0"
    icon="search"
    title="暂无解析记录"
    description="当用户用自然语言记账时，这里会记录每次 AI 解析的输入与结果。"
    compact
  />
  <div v-else class="sheet">
    <button
      v-for="log in parseLogs"
      :key="log.id"
      type="button"
      class="sheet-row sheet-row-click items-start text-left"
      @click="viewParseDetail(log)"
    >
      <div class="flex-1 min-w-0">
        <div class="text-sm text-ink-1 truncate">{{ log.raw_input }}</div>
        <div class="flex items-center gap-2 mt-1.5 flex-wrap">
          <span class="badge" :class="statusBadge(log.status)">{{ statusLabel(log.status) }}</span>
          <span class="text-xs text-ink-3">{{ log.username }}</span>
          <span class="text-xs text-ink-3 amt">{{ formatDuration(log.duration_ms) }}</span>
          <span v-if="log.failure_code" class="badge badge-warn">{{ log.failure_code }}</span>
          <span v-if="log.attempts > 1" class="badge">重试 {{ log.attempts }} 次</span>
        </div>
      </div>
      <div class="text-xs text-ink-4 shrink-0 pt-0.5 amt">{{ formatLocalTime(log.created_at) }}</div>
    </button>
  </div>

  <!-- 分页 -->
  <AdminPager
    v-if="parseLogsPagination.total_pages > 1"
    :page="parseLogsPagination.page"
    :total="parseLogsPagination.total"
    :total-pages="parseLogsPagination.total_pages"
    @change="fetchParseLogs"
  />

  <!-- 解析详情 BaseModal -->
  <BaseModal
    :show="!!showParseDetail"
    title="解析详情"
    size="xl"
    @close="closeParseDetail"
  >
    <div v-if="showParseDetail" class="space-y-4">
      <div class="flex items-center gap-3 flex-wrap p-3 rounded-[var(--radius-sm)] bg-paper-sunk">
        <span class="badge" :class="statusBadge(showParseDetail.status)">{{ statusLabel(showParseDetail.status) }}</span>
        <span class="text-xs text-ink-3">#{{ showParseDetail.id }} · 用户 {{ showParseDetail.username }} · 耗时 {{ formatDuration(showParseDetail.duration_ms) }}</span>
        <span v-if="showParseDetail.channel" class="badge">{{ showParseDetail.channel }}</span>
        <span v-if="showParseDetail.failure_code" class="badge badge-expense">{{ showParseDetail.failure_code }}</span>
        <span v-if="showParseDetail.attempts > 1" class="badge badge-warn">调模型 {{ showParseDetail.attempts }} 次</span>
      </div>

      <div class="admin-stage">
        <div class="admin-stage-label">用户输入</div>
        <div class="admin-stage-box admin-stage-plain">{{ showParseDetail.raw_input }}</div>
      </div>

      <div v-if="showParseDetail.cleaned_input && showParseDetail.cleaned_input !== showParseDetail.raw_input" class="admin-stage">
        <div class="admin-stage-label">清洗后</div>
        <div class="admin-stage-box admin-stage-info">{{ showParseDetail.cleaned_input }}</div>
      </div>

      <div v-if="showParseDetail.ai_response" class="admin-stage">
        <div class="admin-stage-label">AI 返回</div>
        <pre class="admin-stage-box admin-stage-plain mono scroll-thin admin-stage-scroll">{{ showParseDetail.ai_response }}</pre>
      </div>

      <div v-if="showParseDetail.parsed_items" class="admin-stage">
        <div class="admin-stage-label">解析结果</div>
        <pre class="admin-stage-box admin-stage-income mono scroll-thin admin-stage-scroll">{{ showParseDetail.parsed_items }}</pre>
      </div>

      <div v-if="showParseDetail.final_items" class="admin-stage">
        <div class="admin-stage-label">最终提交</div>
        <pre class="admin-stage-box admin-stage-warn mono scroll-thin admin-stage-scroll">{{ showParseDetail.final_items }}</pre>
      </div>

      <div v-if="showParseDetail.error_message" class="admin-stage">
        <div class="admin-stage-label">错误信息</div>
        <div class="admin-stage-box admin-stage-expense">{{ showParseDetail.error_message }}</div>
      </div>
    </div>
  </BaseModal>
</template>
