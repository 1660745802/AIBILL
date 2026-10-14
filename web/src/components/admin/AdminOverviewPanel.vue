<script setup lang="ts">
/**
 * 概览 tab —— 「异常优先」入口。
 *
 * module 自持：系统统计 / 用户一览 / AI 质量快览 / 「需要处理」信号，以及各自的读失败态。
 * 对外只有 `navigate` 一个出口（「去看看」要切到别的 tab，路由归壳管）。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import EmptyState from '@/components/ui/EmptyState.vue'
import Notice from '@/components/ui/Notice.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminStat from './AdminStat.vue'
import type { AdminOpsSignal, TabKey } from './types'

const emit = defineEmits<{ navigate: [tab: TabKey] }>()

const systemStats = ref<any>(null)
const users = ref<any[]>([])
const parseStats = ref<any>(null)
const opsSignals = ref<AdminOpsSignal[]>([])
const loadingOpsSignals = ref(false)
const error = ref(false)

onMounted(() => {
  fetchSystemStats()
  fetchQuickStats()
  fetchOpsSignals()
})

async function fetchSystemStats() {
  try {
    const [usersRes, logsRes] = await Promise.all([
      api.get('/admin/users'),
      api.get('/admin/logs', { params: { days: '1', page_size: 1 } }),
    ])
    const userList = usersRes.data.code === 0 ? usersRes.data.data.items : []
    users.value = userList
    const totalUsers = userList.length
    const activeUsers = userList.filter((u: any) => u.is_active).length
    const totalTransactions = userList.reduce((sum: number, u: any) => sum + (u.transaction_count || 0), 0)

    systemStats.value = {
      totalUsers,
      activeUsers,
      totalTransactions,
      todayLogs: logsRes.data?.data?.pagination?.total || 0,
    }
    error.value = false
  } catch {
    error.value = true
  }
}

async function fetchQuickStats() {
  try {
    const { data } = await api.get('/admin/ai-parse-stats?days=30')
    if (data.code === 0) parseStats.value = data.data
  } catch {
    error.value = true
  }
}

/* 「需要处理」信号：管理面板的价值是**发现异常**，不是看总数。
   汇总 4 个只读接口（解析质量 / 自动化对照 / 通知规则 / App 更新），
   只把「需要人看一眼」的项列出来，并带上跳转 tab。 */
async function fetchOpsSignals(): Promise<void> {
  loadingOpsSignals.value = true
  try {
    const [parseRes, filterRes, rulesRes, updatesRes] = await Promise.allSettled([
      api.get('/admin/ai-parse-stats?days=30'),
      api.get('/admin/filter-stats?days=30'),
      api.get('/admin/notification-rules'),
      api.get('/admin/updates?page=1&page_size=1'),
    ])
    const signals: AdminOpsSignal[] = []

    const parse = parseRes.status === 'fulfilled' ? parseRes.value.data?.data : null
    if (parse && Number(parse.overview?.total ?? 0) > 0) {
      const rate = Number(parse.overview?.success_rate ?? 0)
      if (rate < 80) {
        signals.push({
          level: 'warn',
          title: 'AI 解析成功率偏低',
          detail: `近 30 天 ${rate}%（共 ${parse.overview.total} 次调用）`,
          tab: 'quality',
        })
      }
      const bad = (parse.by_status ?? [])
        .filter((x: any) => x.status === 'error' || x.status === 'timeout')
        .reduce((n: number, x: any) => n + Number(x.count ?? 0), 0)
      // 优先用 022 的干净口径：unavailable = error+timeout，**不含「判非账」**（empty 不是故障）
      const unavailable = Number(parse.overview?.unavailable_count ?? bad)
      const notABill = Number(parse.overview?.not_a_bill_count ?? 0)
      if (unavailable > 0) {
        const topReason = (parse.by_failure_code ?? [])[0]
        signals.push({
          level: (parse.overview?.unavailable_rate ?? 0) >= 30 ? 'danger' : 'warn',
          title: `AI 不可用 ${unavailable} 次（${parse.overview?.unavailable_rate ?? '?'}%）`,
          detail: topReason
            ? `主要原因 ${topReason.failure_code}（${topReason.count} 次）；另有判非账 ${notABill} 次（非故障）`
            : '可在「解析质量」按 failure_code 查看',
          tab: 'quality',
        })
      }
    }

    const filter = filterRes.status === 'fulfilled' ? filterRes.value.data?.data : null
    const drift = (filter?.client?.by_rule ?? []).find(
      (r: any) => r.rule_id === 'client_only.precheck_unknown_expr',
    )
    if (drift && drift.hits > 0) {
      signals.push({
        level: 'warn',
        title: '客户端判据漂移告警',
        detail: `precheck_unknown_expr 命中 ${drift.hits} 次——客户端上的判据形态与服务端清单对不上`,
        tab: 'automation',
      })
    }

    /* 客户端因 AI 不可用丢弃：**服务端无对应判据**，无法直接对账（要靠 failure_code 近似比对）。
       它把「AI 挂了」的后果从用户视野里拿掉了，所以必须在这里露出来。 */
    const unparsed = (filter?.client?.by_rule ?? []).find(
      (r: any) => r.rule_id === 'client_only.unparsed_ai_failed',
    )
    if (unparsed && unparsed.hits > 0) {
      signals.push({
        level: 'warn',
        title: `客户端因 AI 不可用丢弃 ${unparsed.hits} 条`,
        detail: '客户端本地计数（client_only.unparsed_ai_failed）——服务端无对应判据，无法直接对账；AI 是否真的挂了看「解析质量」的 unavailable_rate',
        tab: 'automation',
      })
    }

    const rules = rulesRes.status === 'fulfilled' ? rulesRes.value.data?.data?.items : null
    if (Array.isArray(rules) && !rules.some((r: any) => r.is_active)) {
      signals.push({
        level: 'danger',
        title: '没有激活的通知规则',
        detail: '客户端拉不到判据，会一直回退到本地兜底（拦截口径会与服务端不一致）',
        tab: 'rules',
      })
    }

    const updates = updatesRes.status === 'fulfilled' ? updatesRes.value.data?.data?.items : null
    if (Array.isArray(updates) && updates.length === 0) {
      signals.push({
        level: 'info',
        title: '服务端没有分发的 App 版本',
        detail: 'Android 客户端会回落到 GitHub Release（不影响使用）',
        tab: 'release',
      })
    }

    opsSignals.value = signals
    /* 任一接口读不到就置错误（banner 会显示 + 重试），但已算出的信号照常展示——
       「读不到」与「都正常」是相反的两件事，不能因为 signals 为空就冒充后者。 */
    if ([parseRes, filterRes, rulesRes, updatesRes].some((r) => r.status === 'rejected')) {
      error.value = true
    }
  } catch {
    opsSignals.value = []
    error.value = true
  } finally {
    loadingOpsSignals.value = false
  }
}

function retry(): void {
  error.value = false
  fetchSystemStats()
  fetchQuickStats()
  fetchOpsSignals()
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="retry" />

  <!-- 需要处理（异常优先）：管理面板的价值是发现问题，不是看总数 -->
  <section>
    <div class="ledger-label mb-3">需要处理</div>
    <div v-if="loadingOpsSignals" class="text-center py-4 text-xs text-ink-3">检查中…</div>
    <EmptyState
      v-else-if="opsSignals.length === 0 && !error"
      icon="check"
      title="没有需要处理的事项"
      description="解析成功率、判据漂移、规则激活与版本分发都正常。"
      compact
    />
    <div v-else class="space-y-2">
      <Notice
        v-for="(sig, i) in opsSignals"
        :key="i"
        :tone="sig.level === 'danger' ? 'danger' : sig.level === 'warn' ? 'warn' : 'info'"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm text-ink-1">{{ sig.title }}</div>
            <div class="text-xs text-ink-3 mt-0.5">{{ sig.detail }}</div>
          </div>
          <button type="button" class="act shrink-0" @click="emit('navigate', sig.tab)">去看看</button>
        </div>
      </Notice>
    </div>
  </section>

  <div v-if="systemStats" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <AdminStat :value="systemStats.totalUsers" tone="info">注册用户</AdminStat>
    <AdminStat :value="systemStats.activeUsers" tone="income">活跃用户</AdminStat>
    <AdminStat :value="systemStats.totalTransactions" tone="action">总交易笔数</AdminStat>
    <AdminStat :value="systemStats.todayLogs" tone="warn">今日日志</AdminStat>
  </div>

  <!-- 用户一览 -->
  <section>
    <div class="ledger-label mb-3">用户一览</div>
    <div class="sheet">
      <div v-for="u in users" :key="u.id" class="sheet-row">
        <span class="admin-avatar">{{ (u.nickname || u.username)?.[0]?.toUpperCase() }}</span>
        <div class="flex-1 min-w-0">
          <span class="text-sm text-ink-1">{{ u.nickname || u.username }}</span>
          <span v-if="u.role === 'admin'" class="badge badge-ink ml-1.5">管理员</span>
        </div>
        <span class="text-xs text-ink-3 amt">{{ u.transaction_count }} 笔</span>
      </div>
    </div>
  </section>

  <!-- AI 解析质量快览 -->
  <section v-if="parseStats">
    <div class="ledger-label mb-3">AI 解析质量（近 30 天）</div>
    <div class="grid grid-cols-2 gap-3">
      <AdminStat :value="parseStats.overview.total" tone="action">总调用</AdminStat>
      <AdminStat :value="`${parseStats.overview.success_rate}%`" tone="income">成功率</AdminStat>
    </div>
  </section>
</template>
