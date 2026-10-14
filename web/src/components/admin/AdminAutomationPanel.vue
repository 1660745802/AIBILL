<script setup lang="ts">
/**
 * 自动化对照 tab —— 客户端上报（含漏斗）vs 服务端入站预筛 + AI 失败交叉核对。
 *
 * module 自持两个数据源（filter-stats / ai-parse-stats）与全部派生口径（漏斗、交叉核对、
 * 可比/不可比分组）。这些派生函数原先与别的 tab 的 refs 混在一个 script 里。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminStat from './AdminStat.vue'

const automationDays = ref('30')
const automationStats = ref<any>(null)
/** 服务端口径的失败统计（交叉核对用；主数据是 filter-stats） */
const automationParseStats = ref<any>(null)
const loadingAutomation = ref(false)
const error = ref(false)

onMounted(() => fetchAutomationStats())

async function fetchAutomationStats() {
  loadingAutomation.value = true
  try {
    // 两个接口各司其职：filter-stats 给客户端侧（含漏斗），ai-parse-stats 给服务端 failure_code/by_channel
    const [filterRes, parseRes] = await Promise.allSettled([
      api.get(`/admin/filter-stats?days=${automationDays.value}`),
      api.get(`/admin/ai-parse-stats?days=${automationDays.value}`),
    ])
    automationStats.value =
      filterRes.status === 'fulfilled' && filterRes.value.data.code === 0 ? filterRes.value.data.data : null
    automationParseStats.value =
      parseRes.status === 'fulfilled' && parseRes.value.data.code === 0 ? parseRes.value.data.data : null
    // 主数据读不到才报错；服务端失败统计读不到只影响交叉核对那一块
    error.value = filterRes.status === 'rejected'
  } catch {
    error.value = true
  }
  finally { loadingAutomation.value = false }
}

/** 可比 = 客户端报的 `precheck.*` 与服务端当前判据清单对得上；`client_only.*` 恒不可比 */
function comparableRules(list: any[] | undefined): any[] { return (list ?? []).filter((r) => r.comparable) }
function incomparableRules(list: any[] | undefined): any[] { return (list ?? []).filter((r) => !r.comparable) }
/** 服务端返回的是 0~1 的比例，展示成百分比；null = 窗口内没有数据 */
function rateText(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

// === 漏斗 + 双失败交叉核对（数据来自 filter-stats.client.funnel + ai-parse-stats.by_channel）===
function funnel(): any {
  return automationStats.value?.client?.funnel ?? {
    received: 0, dropped: 0, unparsed_ai_failed: 0, by_channel: [], dropped_reasons: [],
  }
}
/** 通过捕获层 = received − dropped（**不等于**入账数：后面还有预筛/解析） */
function funnelPassed(f = funnel()): number {
  return Math.max(0, (f.received ?? 0) - (f.dropped ?? 0))
}

/**
 * 同窗口/渠道交叉核对：客户端 `unparsed_ai_failed` vs 服务端 `unavailable_count`。
 *
 * ⚠️ 两者口径不完全相同（都如实写明）：
 * - 客户端是**进程内存**计数（重启清零）→ 偏低通常意味着计数器被重启清掉；
 * - 服务端口径含所有调用方（含手动 channel）；`unknown` 是没上报 channel 的老 APK。
 */
function crossCheckRows(): Array<{ channel: string; client: number; server: number; diff: number; pct: string }> {
  const clientRows = (funnel().by_channel ?? []) as any[]
  const serverByCh = new Map<string, number>(
    ((automationParseStats.value?.by_channel ?? []) as any[]).map((c) => [String(c.channel), Number(c.unavailable_count ?? 0)]),
  )
  const channels = [...new Set<string>([...clientRows.map((c) => String(c.channel)), ...serverByCh.keys()])]
  return channels
    .map((channel) => {
      const client = Number(clientRows.find((c) => String(c.channel) === channel)?.unparsed_ai_failed ?? 0)
      const server = serverByCh.get(channel) ?? 0
      const diff = client - server
      const pct = server > 0 ? `${diff >= 0 ? '+' : ''}${((diff / server) * 100).toFixed(0)}%` : '—'
      return { channel, client, server, diff, pct }
    })
    .sort((a, b) => a.channel.localeCompare(b.channel))
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchAutomationStats" />

  <div class="flex items-center justify-between gap-3">
    <span class="ledger-label ledger-label-solid">自动化对照</span>
    <select v-model="automationDays" class="field w-auto" @change="fetchAutomationStats()">
      <option value="7">近 7 天</option>
      <option value="30">近 30 天</option>
      <option value="90">近 90 天</option>
    </select>
  </div>

  <div v-if="loadingAutomation" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="!automationStats"
    icon="spark"
    title="读不到对照数据"
    description="服务端未返回数据，或窗口内还没有任何客户端上报。"
    compact
  />
  <template v-else>
    <section>
      <div class="ledger-label mb-3">客户端拦截（客户端自己上报）</div>
      <div class="grid grid-cols-3 gap-3">
        <AdminStat :value="automationStats.client?.totals?.notifications ?? 0" tone="action">通知总数</AdminStat>
        <AdminStat :value="automationStats.client?.totals?.blocked ?? 0" tone="warn">拦下</AdminStat>
        <AdminStat :value="rateText(automationStats.client?.totals?.block_rate)" tone="info">拦截率</AdminStat>
      </div>
      <div v-if="automationStats.client?.by_channel?.length" class="sheet mt-3">
        <div v-for="c in automationStats.client.by_channel" :key="c.channel" class="sheet-row">
          <span class="text-sm text-ink-1 w-16">{{ c.channel }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ c.notifications }} 条 / 拦 {{ c.blocked }}</span>
          <span class="text-xs text-ink-2 amt">{{ rateText(c.block_rate) }}</span>
        </div>
      </div>
    </section>

    <!-- 客户端漏斗：received → dropped（捕获层早退）→ unparsed（AI 失败丢弃） -->
    <section>
      <div class="ledger-label mb-3">客户端漏斗（捕获层）</div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat :value="funnel().received" tone="action">收到 received</AdminStat>
        <AdminStat :value="funnel().dropped" tone="warn">捕获层早退 dropped</AdminStat>
        <AdminStat :value="funnel().unparsed_ai_failed" tone="expense">AI 失败丢弃 unparsed</AdminStat>
        <AdminStat :value="funnelPassed()" tone="income">通过捕获层</AdminStat>
      </div>
      <p class="text-xs text-ink-3 leading-relaxed mt-2">
        「通过捕获层」= 收到 − 早退；<b>不等于入账数</b>（后面还有预筛/解析）。漏斗只用于定位「在哪一层丢的」。
        <code>unparsed</code> 是 AI 已应答之后客户端对「不确定」的处置，服务端<b>无对应判据</b>。
      </p>
      <div v-if="funnel().dropped_reasons?.length" class="sheet mt-3">
        <div class="sheet-row"><span class="ledger-label">早退原因 dropped_reasons</span></div>
        <div v-for="r in funnel().dropped_reasons" :key="r.rule_id" class="sheet-row">
          <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.rule_id }}</span>
          <span class="text-sm text-ink-1 amt">{{ r.hits }}</span>
        </div>
      </div>
      <div v-if="funnel().by_channel?.length" class="sheet mt-3">
        <div class="sheet-row"><span class="ledger-label">按渠道</span></div>
        <div v-for="c in funnel().by_channel" :key="c.channel" class="sheet-row">
          <span class="text-sm text-ink-1 w-16">{{ c.channel }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">收到 {{ c.received }} / 早退 {{ c.dropped }} / AI 失败 {{ c.unparsed_ai_failed }}</span>
        </div>
      </div>
    </section>

    <!-- 双失败计数交叉核对：客户端内存计数 vs 服务端 failure_code(unavailable) -->
    <section>
      <div class="ledger-label mb-3">双失败交叉核对（客户端 vs 服务端）</div>
      <div class="sheet">
        <div v-for="r in crossCheckRows()" :key="r.channel" class="sheet-row">
          <span class="text-sm text-ink-1 w-16">{{ r.channel }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">客户端 {{ r.client }} / 服务端 {{ r.server }}</span>
          <span class="text-xs amt" :class="r.diff === 0 ? 'text-ink-4' : 'text-ink-2'">{{ r.pct }}</span>
        </div>
      </div>
      <p class="text-xs text-ink-3 leading-relaxed mt-2">
        两者应接近。客户端<b>显著偏低</b>通常意味着内存计数被进程重启清零（P0-2 的直接量化）；
        服务端含所有调用方（含手动 channel），<code>unknown</code> 是未上报 channel 的老 APK。
      </p>
    </section>

    <section>
      <div class="ledger-label mb-3">可比（precheck.*，与服务端同一 rule_id）</div>
      <EmptyState
        v-if="comparableRules(automationStats.client?.by_rule).length === 0"
        icon="check"
        title="没有可比条目"
        description="客户端还没用上服务端下发的判据，或窗口内没拦下任何东西。"
        compact
      />
      <div v-else class="sheet">
        <div v-for="r in comparableRules(automationStats.client?.by_rule)" :key="r.rule_id" class="sheet-row">
          <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.rule_id }}</span>
          <span class="text-sm text-ink-1 amt">{{ r.hits }}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="ledger-label mb-3">不可比（client_only.*，服务端无对应判据）</div>
      <EmptyState
        v-if="incomparableRules(automationStats.client?.by_rule).length === 0"
        icon="check"
        title="没有不可比条目"
        compact
      />
      <div v-else class="sheet">
        <div v-for="r in incomparableRules(automationStats.client?.by_rule)" :key="r.rule_id" class="sheet-row">
          <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.rule_id }}</span>
          <span class="text-sm text-ink-1 amt">{{ r.hits }}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="ledger-label mb-3">服务端入站预筛（同一窗口，只含入站 reason）</div>
      <EmptyState
        v-if="!(automationStats.server?.by_reason ?? []).length"
        icon="filter"
        title="窗口内服务端没拦下任何东西"
        compact
      />
      <div v-else class="sheet">
        <div v-for="r in automationStats.server.by_reason" :key="r.reason" class="sheet-row">
          <span class="flex-1 text-xs mono text-ink-1 truncate">{{ r.reason }}</span>
          <span class="text-sm text-ink-1 amt">{{ r.hits }}</span>
        </div>
      </div>
    </section>

    <p class="text-xs text-ink-3 leading-relaxed">{{ automationStats.note }}</p>
  </template>
</template>
