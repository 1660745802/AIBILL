<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import api from '@/api/index'
import BaseModal from '@/components/ui/BaseModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Notice from '@/components/ui/Notice.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()

type TabKey =
  | 'overview'
  | 'users'
  | 'ai'
  | 'quality'
  | 'automation'
  | 'triage'
  | 'logs'
  | 'rules'
  | 'release'

/* ── 导航按「问题」分三组（与侧栏同一原则），而不是按接口 ──
   上一版是 9 个 tab 平铺：“解析质量 / 自动化对照 / 系统日志”概念上同族却并列，
   “邀请码”本是“用户与访问”的子项，手机端还得横滑 9 个 chip。
   现在：访问（用户+邀请码）· 自动化（质量/对照/规则/AI 设置）· 运维（概览/日志/App 更新）。 */
interface NavItem { key: TabKey; label: string; short: string; icon: string }
const navGroups: { key: string; label: string; items: NavItem[] }[] = [
  {
    key: 'access',
    label: '访问',
    items: [{ key: 'users', label: '用户与邀请码', short: '用户', icon: 'users' }],
  },
  {
    key: 'automation',
    label: '自动化',
    items: [
      { key: 'quality', label: '解析质量', short: '质量', icon: 'search' },
      { key: 'triage', label: '未解析裁决', short: '裁决', icon: 'check' },
      { key: 'automation', label: '自动化对照', short: '自动化', icon: 'spark' },
      { key: 'rules', label: '通知规则', short: '规则', icon: 'code' },
      { key: 'ai', label: 'AI 设置', short: 'AI', icon: 'spark' },
    ],
  },
  {
    key: 'ops',
    label: '运维',
    items: [
      { key: 'overview', label: '概览', short: '概览', icon: 'overview' },
      { key: 'logs', label: '系统日志', short: '日志', icon: 'list' },
      { key: 'release', label: 'App 更新', short: '更新', icon: 'upload' },
    ],
  },
]
/** 手机端 chip 用扁平列表（底栏塞不进组） */
const navItems: NavItem[] = navGroups.flatMap((g) => g.items)

const TAB_KEYS: TabKey[] = navItems.map((i) => i.key)

/* tab 落 URL（`/admin?tab=xxx`）：可刷新、可深链、可分享。
   只接受已知 key，URL 里塞奇怪值就回退到「概览」。 */
function tabFromQuery(): TabKey {
  const t = String(route.query.tab ?? '')
  return (TAB_KEYS as string[]).includes(t) ? (t as TabKey) : 'overview'
}
const activeTab = ref<TabKey>(tabFromQuery())

/* 读失败的统一展示（上一版有 11 处 静默 catch：读不到时页面空着，
   管理员会判成“没有数据”而不是“读不到”）。

   ⚠️ 粒度是**每次 fetch**（不是每个 tab）：一个 tab 可能有两个独立请求
   （quality = 统计 + 日志；overview = 系统统计 + 「需要处理」信号），
   共用一个 key 会让「一个成功」把「另一个失败」的错误抹掉（复核 A-04）。 */
const loadErrors = ref<Record<string, boolean>>({})
function markLoaded(key: string): void { delete loadErrors.value[key] }
function markFailed(key: string): void { loadErrors.value[key] = true }

/** 每个 tab 的失败来源有哪些（AI 设置的配置也走 fetchAdminData） */
const TAB_FETCH_KEYS: Record<TabKey, string[]> = {
  overview: ['overview', 'ops'],
  users: ['users'],
  ai: ['users'],
  quality: ['quality-stats', 'quality-logs'],
  automation: ['automation'],
  triage: ['triage'],
  logs: ['logs'],
  rules: ['rules'],
  release: ['release'],
}
function tabHasError(key: TabKey): boolean {
  return (TAB_FETCH_KEYS[key] ?? [key]).some((k) => loadErrors.value[k] === true)
}
function retryActiveTab(): void {
  const key = activeTab.value
  markLoaded(key)
  if (key === 'overview') { fetchSystemStats(); fetchOpsSignals() }
  else if (key === 'users') fetchAdminData()
  else if (key === 'quality') { fetchParseStats(); fetchParseLogs(1) }
  else if (key === 'automation') fetchAutomationStats()
  else if (key === 'triage') fetchTriage()
  else if (key === 'rules') fetchNotifRules()
  else if (key === 'logs') fetchAppLogs()
  else if (key === 'release') fetchAppUpdates()
}

/* 浏览器前进/后退会改 URL 但不走 switchTab → 这里补上反向同步 */
watch(
  () => route.query.tab,
  (v) => {
    const t = String(v ?? '')
    const key = (TAB_KEYS as string[]).includes(t) ? (t as TabKey) : 'overview'
    if (key !== activeTab.value) switchTab(key)
  },
)

function switchTab(key: TabKey) {
  activeTab.value = key
  // replace 避免每次切 tab 都往历史里塞一条
  router.replace({ query: { ...route.query, tab: key } })
  if (key === 'logs') fetchAppLogs()
  if (key === 'rules') fetchNotifRules()
  if (key === 'automation') fetchAutomationStats()
  if (key === 'triage') fetchTriage()
  if (key === 'release') fetchAppUpdates()
  if (key === 'overview') fetchOpsSignals()
}

// 系统概览
const systemStats = ref<any>(null)

// 管理员数据
const inviteCodes = ref<any[]>([])
const users = ref<any[]>([])
const globalSettings = ref<Record<string, string>>({})

// AI 解析质量数据
const parseStats = ref<any>(null)
const parseLogs = ref<any[]>([])
const parseLogsPagination = ref({ page: 1, page_size: 20, total: 0, total_pages: 0 })
const parseLogsFilter = ref({ status: '', days: '30' })
const showParseDetail = ref<any>(null)
const loadingParseLogs = ref(false)

// 应用日志
const appLogs = ref<any[]>([])
const appLogsPagination = ref({ page: 1, page_size: 50, total: 0 })
const appLogsFilter = ref({ level: '', module: '', days: '7' })
const loadingAppLogs = ref(false)

// 通知规则
const notifRules = ref<any[]>([])
const loadingRules = ref(false)

// 邀请码生成
const newCodeMaxUses = ref(1)
const generating = ref(false)
const copiedCodeId = ref<number | null>(null)

// 用户详情/操作
const showUserDetail = ref<any>(null)
const userStats = ref<any>(null)
const resetPasswordId = ref<number | null>(null)
const newPasswordInput = ref('')

onMounted(async () => {
  if (!auth.isAdmin) return
  await fetchAdminData()
  fetchSystemStats()
  /* 深链（`/admin?tab=xxx`）进来时，把该 tab 的数据也取上——否则会看到空内容 */
  const t = activeTab.value
  if (t === 'quality') { fetchParseStats(); fetchParseLogs(1) }
  else if (t === 'automation') fetchAutomationStats()
  else if (t === 'triage') fetchTriage()
  else if (t === 'rules') fetchNotifRules()
  else if (t === 'logs') fetchAppLogs()
  else if (t === 'release') fetchAppUpdates()
  fetchOpsSignals()
})

async function fetchAdminData() {
  markLoaded('users') // 开始加载 = 清掉上一次的错误提示
  try {
    const [codesRes, usersRes, settingsRes] = await Promise.all([
      api.get('/admin/invite-codes'),
      api.get('/admin/users'),
      api.get('/admin/settings'),
    ])
    if (codesRes.data.code === 0) inviteCodes.value = codesRes.data.data.items
    if (usersRes.data.code === 0) users.value = usersRes.data.data.items
    if (settingsRes.data.code === 0) globalSettings.value = settingsRes.data.data
    await fetchParseStats()
    await fetchParseLogs()
  } catch {
    markFailed('users')
  }
}

async function generateCode() {
  generating.value = true
  try {
    const { data } = await api.post('/admin/invite-codes', { max_uses: newCodeMaxUses.value })
    if (data.code === 0) {
      inviteCodes.value.unshift(data.data)
      toast.success('邀请码已生成')
    }
  } catch { /* ignore */ }
  finally { generating.value = false }
}

async function copyCode(code: any) {
  try {
    await navigator.clipboard.writeText(code.code)
    copiedCodeId.value = code.id
    setTimeout(() => {
      if (copiedCodeId.value === code.id) copiedCodeId.value = null
    }, 1500)
  } catch {
    toast.error('复制失败，请手动选择')
  }
}

async function revokeCode(id: number) {
  if (!(await confirm({
    title: '作废邀请码',
    body: '作废后该邀请码立即失效，已注册用户不受影响。',
    danger: true,
    confirmText: '作废',
  }))) return
  try {
    await api.delete(`/admin/invite-codes/${id}`)
    await fetchAdminData()
  } catch { /* ignore */ }
}

async function toggleUser(id: number, currentActive: number) {
  try {
    await api.put(`/admin/users/${id}`, { is_active: currentActive ? 0 : 1 })
    await fetchAdminData()
  } catch { /* ignore */ }
}

async function viewUserDetail(userId: number) {
  if (showUserDetail.value?.id === userId) {
    showUserDetail.value = null
    return
  }
  try {
    const { data } = await api.get(`/admin/users/${userId}/stats`)
    if (data.code === 0) {
      showUserDetail.value = data.data.user
      userStats.value = data.data.stats
    }
  } catch { /* ignore */ }
}

async function resetPassword() {
  if (!resetPasswordId.value || newPasswordInput.value.length < 6) {
    toast.error('密码至少6个字符')
    return
  }
  try {
    const { data } = await api.put(`/admin/users/${resetPasswordId.value}/reset-password`, {
      new_password: newPasswordInput.value,
    })
    if (data.code === 0) {
      toast.success('密码已重置')
      resetPasswordId.value = null
      newPasswordInput.value = ''
    } else {
      toast.error(data.message)
    }
  } catch { /* 提示见 api 拦截器 */ }
}

async function deleteUser(id: number, username: string) {
  if (!(await confirm({
    title: '删除用户',
    body: `用户「${username}」及其全部交易、预算、订阅等数据将被永久清除，无法恢复。`,
    danger: true,
  }))) return
  try {
    const { data } = await api.delete(`/admin/users/${id}`)
    if (data.code === 0) {
      toast.success(data.message)
      showUserDetail.value = null
      await fetchAdminData()
    } else {
      toast.error(data.message)
    }
  } catch { /* 提示见 api 拦截器 */ }
}

async function saveSettings() {
  try {
    await api.put('/admin/settings', globalSettings.value)
    toast.success('设置已保存')
  } catch { /* ignore */ }
}

async function fetchParseStats() {
  markLoaded('quality-stats') // 开始加载 = 清掉上一次的错误提示
  try {
    const { data } = await api.get('/admin/ai-parse-stats', {
      params: { days: parseLogsFilter.value.days },
    })
    if (data.code === 0) parseStats.value = data.data
  } catch {
    markFailed('quality-stats')
  }
}

async function fetchParseLogs(page = 1) {
  markLoaded('quality-logs') // 开始加载 = 清掉上一次的错误提示
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
    markFailed('quality-logs')
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

function formatLocalTime(utcStr: string | null | undefined): string {
  if (!utcStr) return '-'
  const d = new Date(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z')
  if (isNaN(d.getTime())) return utcStr.slice(5, 16)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}`
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

// === 系统概览 ===
async function fetchSystemStats() {
  markLoaded('overview') // 开始加载 = 清掉上一次的错误提示
  try {
    const [usersRes, logsRes] = await Promise.all([
      api.get('/admin/users'),
      api.get('/admin/logs', { params: { days: '1', page_size: 1 } }),
    ])
    const userList = usersRes.data.code === 0 ? usersRes.data.data.items : []
    const totalUsers = userList.length
    const activeUsers = userList.filter((u: any) => u.is_active).length
    const totalTransactions = userList.reduce((sum: number, u: any) => sum + (u.transaction_count || 0), 0)

    systemStats.value = {
      totalUsers,
      activeUsers,
      totalTransactions,
      todayLogs: logsRes.data?.data?.pagination?.total || 0,
    }
  } catch {
    markFailed('overview')
  }
}

// === 应用日志 ===
async function fetchAppLogs(page = 1) {
  markLoaded('logs') // 开始加载 = 清掉上一次的错误提示
  loadingAppLogs.value = true
  try {
    const params: any = { page, page_size: appLogsPagination.value.page_size, days: appLogsFilter.value.days }
    if (appLogsFilter.value.level) params.level = appLogsFilter.value.level
    if (appLogsFilter.value.module) params.module = appLogsFilter.value.module
    const { data } = await api.get('/admin/logs', { params })
    if (data.code === 0) {
      appLogs.value = data.data.items ?? []
      appLogsPagination.value = { ...appLogsPagination.value, ...(data.data.pagination ?? {}) }
    }
  } catch {
    markFailed('logs')
  }
  finally { loadingAppLogs.value = false }
}

function logLevelBadge(level: string): string {
  const map: Record<string, string> = { info: 'badge-info', warn: 'badge-warn', error: 'badge-expense' }
  return map[level] || 'badge'
}

/* 「需要处理」信号：管理面板的价值是**发现异常**，不是看总数。
   汇总 4 个只读接口（解析质量 / 自动化对照 / 通知规则 / App 更新），
   只把「需要人看一眼」的项列出来，并带上跳转 tab。 */
const opsSignals = ref<{ level: 'warn' | 'danger' | 'info'; title: string; detail: string; tab: TabKey }[]>([])
const loadingOpsSignals = ref(false)

async function fetchOpsSignals(): Promise<void> {
  loadingOpsSignals.value = true
  markLoaded('ops')
  try {
    const [parseRes, filterRes, rulesRes, updatesRes] = await Promise.allSettled([
      api.get('/admin/ai-parse-stats?days=30'),
      api.get('/admin/filter-stats?days=30'),
      api.get('/admin/notification-rules'),
      api.get('/admin/updates?page=1&page_size=1'),
    ])
    const signals: typeof opsSignals.value = []

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
      markFailed('ops')
    }
  } catch {
    opsSignals.value = []
    markFailed('ops')
  } finally {
    loadingOpsSignals.value = false
  }
}

// === 自动化对照（客户端上报 vs 服务端入站预筛 + AI 失败交叉核对）===
const automationDays = ref('30')
const automationStats = ref<any>(null)
/** 服务端口径的失败统计（交叉核对用；主数据是 filter-stats） */
const automationParseStats = ref<any>(null)
const loadingAutomation = ref(false)

async function fetchAutomationStats() {
  markLoaded('automation') // 开始加载 = 清掉上一次的错误提示
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
    if (filterRes.status === 'rejected') markFailed('automation')
  } catch {
    markFailed('automation')
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

// === 未解析裁决（P1 列表 + P2 裁决，design: docs/UNPARSED-TRIAGE.md）===
const triageFilter = ref({ days: '7', channel: '', action: '', includeRaw: false })
const triageStats = ref<any>(null)
const loadingTriage = ref(false)
const triageSubmitting = ref<number | null>(null)
/** 每条的理由输入（裁决必填，供审计/复盘） */
const triageReasons = ref<Record<number, string>>({})

async function fetchTriage() {
  markLoaded('triage') // 开始加载 = 清掉上一次的错误提示
  loadingTriage.value = true
  try {
    const params = new URLSearchParams({ days: triageFilter.value.days })
    if (triageFilter.value.channel) params.set('channel', triageFilter.value.channel)
    if (triageFilter.value.action) params.set('triage', triageFilter.value.action)
    if (triageFilter.value.includeRaw) params.set('include_raw', '1')
    const { data } = await api.get(`/admin/unparsed?${params.toString()}`)
    triageStats.value = data.code === 0 ? data.data : null
  } catch {
    markFailed('triage')
  } finally { loadingTriage.value = false }
}

/** 三个动作：只写裁决记录（服务端不写账、不回推客户端） */
async function submitTriage(id: number, action: 'mark_bill' | 'mark_not_bill' | 'mark_rule_missing') {
  const reason = (triageReasons.value[id] ?? '').trim()
  if (!reason) { toast.error('请先填写裁决理由'); return }
  triageSubmitting.value = id
  try {
    await api.post(`/admin/unparsed/${id}/triage`, { action, reason })
    toast.success('裁决已记录')
    await fetchTriage()
  } catch { /* 拦截器已提示 */ }
  finally { triageSubmitting.value = null }
}

// === App 更新（APK 自托管分发）===
const appUpdates = ref<any[]>([])
const appUpdatesTotal = ref(0)
const appUpdatesPage = ref(1)
const appUpdatesPageSize = 20
const loadingUpdates = ref(false)
const uploadingApk = ref(false)
const apkFile = ref<File | null>(null)
const apkForm = ref({ version_name: '', version_code: '', changelog: '', force_update: false })
const activeUpdate = computed(() => appUpdates.value.find((u) => u.is_active) ?? null)

async function fetchAppUpdates(page = 1) {
  markLoaded('release') // 开始加载 = 清掉上一次的错误提示
  loadingUpdates.value = true
  try {
    const { data } = await api.get(`/admin/updates?page=${page}&page_size=${appUpdatesPageSize}`)
    if (data.code === 0) {
      appUpdates.value = data.data.items
      appUpdatesTotal.value = data.data.total
      appUpdatesPage.value = data.data.page
    }
  } catch {
    markFailed('release')
  }
  finally { loadingUpdates.value = false }
}

function pickApk(e: Event): void {
  apkFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function uploadApk(): Promise<void> {
  if (!apkFile.value) { toast.error('请先选择 APK 文件'); return }
  if (!apkForm.value.version_name.trim()) { toast.error('versionName 必填'); return }
  const code = Number(apkForm.value.version_code)
  if (!Number.isInteger(code) || code <= 0) { toast.error('versionCode 必须是正整数'); return }
  /* 客户端侧先提醒 §3.8 的纪律（服务端也会拦）：versionCode 必须**严格递增且唯一**，
     跳号正常。这里只做提示，不代替服务端校验。 */
  if (activeUpdate.value && code <= activeUpdate.value.version_code) {
    toast.error(`versionCode 必须大于当前激活版本（${activeUpdate.value.version_code}）`)
    return
  }
  const ok = await confirm({
    title: '上传并激活该版本？',
    body:
      `上传后会立即对所有客户端生效：低于 versionCode ${code} 的客户端会看到更新` +
      (apkForm.value.force_update
        ? '，且因为勾选了「强制更新」，它们会被要求升级。'
        : '。'),
    confirmText: '上传并激活',
    danger: apkForm.value.force_update,
  })
  if (!ok) return
  uploadingApk.value = true
  try {
    const fd = new FormData()
    fd.append('apk_file', apkFile.value)
    fd.append('version_name', apkForm.value.version_name.trim())
    fd.append('version_code', String(code))
    fd.append('changelog', apkForm.value.changelog)
    fd.append('force_update', apkForm.value.force_update ? 'true' : 'false')
    // APK 可能上百 MB → 覆盖默认 10s 超时
    const { data } = await api.post('/admin/updates', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    })
    if (data.code === 0) {
      toast.success('版本已上传并激活')
      apkForm.value = { version_name: '', version_code: '', changelog: '', force_update: false }
      apkFile.value = null
      await fetchAppUpdates(1)
    }
  } catch { /* 提示见 api 拦截器 */ }
  finally { uploadingApk.value = false }
}

function formatBytes(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

// === 通知规则 ===
async function fetchNotifRules() {
  markLoaded('rules') // 开始加载 = 清掉上一次的错误提示
  loadingRules.value = true
  try {
    const { data } = await api.get('/admin/notification-rules')
    if (data.code === 0) notifRules.value = data.data.items
  } catch {
    markFailed('rules')
  }
  finally { loadingRules.value = false }
}

async function activateRule(id: number) {
  try {
    const { data } = await api.put(`/admin/notification-rules/${id}/activate`)
    if (data.code === 0) {
      toast.success(data.message)
      await fetchNotifRules()
    }
  } catch { /* 提示见 api 拦截器 */ }
}

/* 详情统一走 BaseModal（上一版规则预览是内联展开，与解析详情/用户明细两种形态并存） */
const showRulePreview = ref<any>(null)
function openRulePreview(rule: any): void {
  showRulePreview.value = rule
}

function formatRuleJson(rule: any): string {
  if (!rule.rules) return '{}'
  try {
    const parsed = typeof rule.rules === 'string' ? JSON.parse(rule.rules) : rule.rules
    return JSON.stringify(parsed, null, 2)
  } catch {
    return String(rule.rules)
  }
}

// === 用户账单明细 ===
const userTransactions = ref<any[]>([])
const userTransactionsLoading = ref(false)
const viewingUserId = ref<number | null>(null)
const userTxPage = ref(1)
const userTxTotal = ref(0)

async function fetchUserTransactions(userId: number, page = 1) {
  viewingUserId.value = userId
  userTransactionsLoading.value = true
  userTxPage.value = page
  try {
    const { data } = await api.get(`/admin/users/${userId}/transactions`, {
      params: { page, page_size: 20 },
    })
    if (data.code === 0) {
      userTransactions.value = data.data.items
      userTxTotal.value = data.data.total
    }
  } catch { /* 提示见 api 拦截器 */ }
  finally { userTransactionsLoading.value = false }
}

function closeUserTransactions() {
  viewingUserId.value = null
  userTransactions.value = []
}
</script>

<template>
  <div>
    <div class="flex flex-col md:flex-row md:gap-6">
      <!-- ≥md：左侧 192px sticky 子导航 -->
      <aside class="hidden md:block shrink-0" style="width: 192px">
        <div class="admin-nav">
          <h1 class="page-title mb-0.5">管理面板</h1>
          <p class="text-xs text-ink-3 mb-4">系统管理与监控</p>
          <nav class="flex flex-col gap-3">
            <div v-for="group in navGroups" :key="group.key">
              <div class="admin-nav-group">{{ group.label }}</div>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="admin-nav-item"
                :class="activeTab === item.key ? 'admin-nav-item-active' : ''"
                @click="switchTab(item.key)"
              >
                <AppIcon :name="item.icon" :size="16" />
                <span>{{ item.label }}</span>
              </button>
            </div>
          </nav>
        </div>
      </aside>

      <!-- <md：横向滚动 chip -->
      <div class="md:hidden mb-4">
        <h1 class="page-title mb-3">管理面板</h1>
        <div class="scroll-x flex gap-2 pb-1">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="chip shrink-0"
            :class="activeTab === item.key ? 'chip-active' : ''"
            @click="switchTab(item.key)"
          >{{ item.short }}</button>
        </div>
      </div>

      <!-- 右侧内容区 -->
      <div class="flex-1 min-w-0">

        <!-- 读不到数据时的统一提示（替代上一版 11 处静默 catch：
             读不到 ≠ 没有数据，不提示就等于谎报） -->
        <Notice v-if="tabHasError(activeTab)" tone="warn" class="mb-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs">读不到数据（接口失败或超时）—— 这不是「没有数据」。</span>
            <button type="button" class="act shrink-0" @click="retryActiveTab()">重试</button>
          </div>
        </Notice>

        <!-- ───── 概览 ───── -->
        <div v-if="activeTab === 'overview'" class="space-y-6">
          <!-- 需要处理（异常优先）：管理面板的价值是发现问题，不是看总数 -->
          <section>
            <div class="ledger-label mb-3">需要处理</div>
            <div v-if="loadingOpsSignals" class="text-center py-4 text-xs text-ink-3">检查中…</div>
            <EmptyState
              v-else-if="opsSignals.length === 0 && !loadErrors.ops"
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
                  <button type="button" class="act shrink-0" @click="switchTab(sig.tab)">去看看</button>
                </div>
              </Notice>
            </div>
          </section>

          <div v-if="systemStats" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="admin-stat" style="border-top-color: var(--color-info)">
              <div class="admin-stat-num">{{ systemStats.totalUsers }}</div>
              <div class="admin-stat-label">注册用户</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-income)">
              <div class="admin-stat-num">{{ systemStats.activeUsers }}</div>
              <div class="admin-stat-label">活跃用户</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-action)">
              <div class="admin-stat-num">{{ systemStats.totalTransactions }}</div>
              <div class="admin-stat-label">总交易笔数</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-warn)">
              <div class="admin-stat-num">{{ systemStats.todayLogs }}</div>
              <div class="admin-stat-label">今日日志</div>
            </div>
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
            <div class="grid grid-cols-3 gap-3">
              <div class="admin-stat" style="border-top-color: var(--color-action)">
                <div class="admin-stat-num">{{ parseStats.overview.total }}</div>
                <div class="admin-stat-label">总调用</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-income)">
                <div class="admin-stat-num">{{ parseStats.overview.success_rate }}%</div>
                <div class="admin-stat-label">成功率</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-warn)">
                <div class="admin-stat-num">{{ parseStats.modification?.modification_rate || 0 }}%</div>
                <div class="admin-stat-label">修正率</div>
              </div>
            </div>
          </section>
        </div>

        <!-- ───── 用户管理 ───── -->
        <div v-if="activeTab === 'users'">
          <div class="flex items-center justify-between mb-3">
            <span class="ledger-label">用户管理</span>
            <span class="text-xs text-ink-3">共 {{ users.length }} 人</span>
          </div>
          <div class="sheet">
            <template v-for="u in users" :key="u.id">
              <div class="sheet-row sheet-row-click flex-wrap" @click="viewUserDetail(u.id)">
                <span class="admin-avatar">{{ (u.nickname || u.username)[0].toUpperCase() }}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-ink-1">
                    {{ u.nickname || u.username }}
                    <span v-if="u.role === 'admin'" class="badge badge-ink ml-1">管理员</span>
                  </div>
                  <div class="text-xs text-ink-3">{{ u.transaction_count }} 笔 · {{ formatLocalTime(u.created_at) }}</div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0" @click.stop>
                  <button type="button" class="act" @click="fetchUserTransactions(u.id)">账单</button>
                  <button
                    v-if="u.id !== auth.user?.id"
                    type="button"
                    class="act"
                    :class="u.is_active ? 'act-danger' : ''"
                    @click="toggleUser(u.id, u.is_active)"
                  >{{ u.is_active ? '禁用' : '启用' }}</button>
                  <span v-else class="text-xs text-ink-4">当前</span>
                  <AppIcon name="chevronDown" :size="15" class="chev-link" :style="showUserDetail?.id === u.id ? 'transform: rotate(180deg)' : ''" />
                </div>
              </div>

              <!-- 行内展开详情 -->
              <div v-if="showUserDetail?.id === u.id" class="admin-detail">
                <div v-if="userStats" class="grid grid-cols-3 gap-3 mb-4">
                  <div class="admin-mini">
                    <div class="admin-mini-num amt">{{ userStats.total_transactions }}</div>
                    <div class="admin-stat-label">总笔数</div>
                  </div>
                  <div class="admin-mini">
                    <Money :value="userStats.total_expense" size="md" tone="expense" sign="none" absolute />
                    <div class="admin-stat-label">总支出</div>
                  </div>
                  <div class="admin-mini">
                    <Money :value="userStats.total_income" size="md" tone="income" sign="none" absolute />
                    <div class="admin-stat-label">总收入</div>
                  </div>
                </div>
                <div class="space-y-2">
                  <div class="flex flex-col sm:flex-row gap-2">
                    <input
                      v-model="newPasswordInput"
                      type="text"
                      class="field flex-1"
                      placeholder="输入新密码（≥6 位）"
                    />
                    <button
                      type="button"
                      class="btn btn-outline"
                      @click="resetPasswordId = u.id; resetPassword()"
                    >
                      <AppIcon name="key" :size="15" />
                      重置密码
                    </button>
                  </div>
                  <button
                    v-if="u.id !== auth.user?.id"
                    type="button"
                    class="btn btn-danger btn-block"
                    @click="deleteUser(u.id, u.username)"
                  >
                    <AppIcon name="trash" :size="15" />
                    删除用户（不可恢复）
                  </button>
                </div>
              </div>
            </template>
          </div>

          <!-- 邀请码（并入本 tab：访问管理本来就是同一件事） -->
          <section class="mt-6">
            <div class="ledger-label mb-3">邀请码</div>


          <div class="surface p-3 mb-4 flex flex-wrap items-center gap-3">
            <div class="flex items-center gap-2">
              <input
                v-model.number="newCodeMaxUses"
                type="number"
                min="1"
                max="100"
                class="field w-16 text-center"
              />
              <span class="text-xs text-ink-3">次可用</span>
            </div>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="generating"
              @click="generateCode"
            >
              <AppIcon name="plus" :size="15" />
              {{ generating ? '生成中…' : '生成邀请码' }}
            </button>
          </div>

          <div v-if="inviteCodes.length > 0" class="sheet">
            <div v-for="code in inviteCodes" :key="code.id" class="sheet-row">
              <code class="admin-code">{{ code.code }}</code>
              <span class="text-xs text-ink-3 amt">已用 {{ code.used_count }}/{{ code.max_uses }}</span>
              <div class="ml-auto flex items-center gap-1.5">
                <button type="button" class="act" @click="copyCode(code)">
                  {{ copiedCodeId === code.id ? '已复制' : '复制' }}
                </button>
                <button
                  v-if="code.used_count < code.max_uses"
                  type="button"
                  class="act act-danger"
                  @click="revokeCode(code.id)"
                >作废</button>
                <span v-else class="text-xs text-ink-4">已用完</span>
              </div>
            </div>
          </div>
          <EmptyState
            v-else
            icon="ticket"
            title="还没有邀请码"
            description="生成邀请码分享给朋友，他们凭码即可注册。"
            compact
          >
            <button type="button" class="btn btn-primary" @click="generateCode">
              <AppIcon name="plus" :size="15" />
              生成第一个
            </button>
          </EmptyState>
        
          </section>
        </div>

        <!-- ───── AI 设置 ───── -->
        <div v-if="activeTab === 'ai'">
          <div class="ledger-label mb-3">AI 模型配置</div>
          <div class="surface p-4 space-y-4">
            <div>
              <label class="field-label">API 地址</label>
              <input v-model="globalSettings.ai_base_url" type="text" class="field" placeholder="https://api.openai.com/v1" />
            </div>
            <div>
              <label class="field-label">API Key</label>
              <input v-model="globalSettings.ai_api_key" type="password" class="field" placeholder="sk-..." />
            </div>
            <div>
              <label class="field-label">模型名称</label>
              <input v-model="globalSettings.ai_model" type="text" class="field" placeholder="gpt-4o-mini" />
            </div>
            <button type="button" class="btn btn-primary btn-block" @click="saveSettings">保存设置</button>
          </div>
        </div>

        <!-- ───── 解析质量 ───── -->
        <div v-if="activeTab === 'quality'">
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
          <div v-if="parseStats" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <div class="admin-stat" style="border-top-color: var(--color-action)">
              <div class="admin-stat-num">{{ parseStats.overview.total }}</div>
              <div class="admin-stat-label">总调用</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-income)">
              <div class="admin-stat-num">{{ parseStats.overview.success_rate }}%</div>
              <div class="admin-stat-label">成功率</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-info)">
              <div class="admin-stat-num">{{ formatDuration(parseStats.overview.avg_duration_ms) }}</div>
              <div class="admin-stat-label">平均耗时</div>
            </div>
            <div class="admin-stat" style="border-top-color: var(--color-warn)">
              <div class="admin-stat-num">{{ parseStats.modification.modification_rate }}%</div>
              <div class="admin-stat-label">修正率</div>
            </div>
          </div>

          <!-- 服务端预筛（被规则挡下、根本没调模型）——查看本页“空结果率”时必须与它一起看 -->
          <section v-if="parseStats && parseStats.prefilter" class="mt-5">
            <div class="ledger-label mb-3">服务端预筛（挡下即不调模型）</div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div class="admin-stat" style="border-top-color: var(--color-action)">
                <div class="admin-stat-num">{{ parseStats.prefilter.total }}</div>
                <div class="admin-stat-label">挡下总数</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-income)">
                <div class="admin-stat-num">{{ parseStats.prefilter.inbound }}</div>
                <div class="admin-stat-label">入站（调模型前）</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-info)">
                <div class="admin-stat-num">{{ parseStats.prefilter.outbound }}</div>
                <div class="admin-stat-label">出站（模型结果后）</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-warn)">
                <div class="admin-stat-num">{{ parseStats.prefilter.perDay }}</div>
                <div class="admin-stat-label">日均挡下</div>
              </div>
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
              <div class="admin-stat" style="border-top-color: var(--color-warn)">
                <div class="admin-stat-num">{{ parseStats.overview.unavailable_rate }}%</div>
                <div class="admin-stat-label">不可用率（{{ parseStats.overview.unavailable_count }} 次）</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-info)">
                <div class="admin-stat-num">{{ parseStats.overview.not_a_bill_rate }}%</div>
                <div class="admin-stat-label">判非账（{{ parseStats.overview.not_a_bill_count }} 次·非故障）</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-income)">
                <div class="admin-stat-num">{{ parseStats.overview.retry_rescued }}</div>
                <div class="admin-stat-label">重试救回（共重试 {{ parseStats.overview.retried_count }}）</div>
              </div>
              <div class="admin-stat" style="border-top-color: var(--color-action)">
                <div class="admin-stat-num">{{ parseStats.overview.success_count }}</div>
                <div class="admin-stat-label">解析成功</div>
              </div>
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
                  <span v-if="log.user_modified" class="badge badge-warn">已修正</span>
                </div>
              </div>
              <div class="text-xs text-ink-4 shrink-0 pt-0.5 amt">{{ formatLocalTime(log.created_at) }}</div>
            </button>
          </div>

          <!-- 分页 -->
          <div v-if="parseLogsPagination.total_pages > 1" class="flex items-center justify-between mt-4 pt-3 border-t border-rule">
            <span class="text-xs text-ink-3 amt">共 {{ parseLogsPagination.total }} 条</span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn btn-outline btn-sm btn-icon"
                :disabled="parseLogsPagination.page <= 1"
                @click="fetchParseLogs(parseLogsPagination.page - 1)"
              ><AppIcon name="chevronLeft" :size="14" /></button>
              <span class="px-2 text-xs text-ink-2 amt">{{ parseLogsPagination.page }} / {{ parseLogsPagination.total_pages }}</span>
              <button
                type="button"
                class="btn btn-outline btn-sm btn-icon"
                :disabled="parseLogsPagination.page >= parseLogsPagination.total_pages"
                @click="fetchParseLogs(parseLogsPagination.page + 1)"
              ><AppIcon name="chevronRight" :size="14" /></button>
            </div>
          </div>
        </div>

        <!-- ───── 系统日志 ───── -->
        <div v-if="activeTab === 'logs'">
          <div class="ledger-label mb-3">系统日志</div>
          <div class="flex gap-2 mb-3 flex-wrap">
            <select v-model="appLogsFilter.level" class="field w-auto" @change="fetchAppLogs(1)">
              <option value="">全部级别</option>
              <option value="info">INFO</option>
              <option value="warn">WARN</option>
              <option value="error">ERROR</option>
            </select>
            <select v-model="appLogsFilter.days" class="field w-auto" @change="fetchAppLogs(1)">
              <option value="1">今天</option>
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
            </select>
            <input v-model="appLogsFilter.module" placeholder="模块名" class="field w-28" @change="fetchAppLogs(1)" />
          </div>

          <div v-if="loadingAppLogs" class="text-center py-6 text-xs text-ink-3">加载中…</div>
          <EmptyState
            v-else-if="appLogs.length === 0"
            icon="list"
            title="暂无日志"
            description="调整上方的级别或时间范围，或等待系统产生新日志。"
            compact
          />
          <div v-else class="surface surface-flush">
            <div v-for="log in appLogs" :key="log.id" class="admin-log-row">
              <span class="badge" :class="logLevelBadge(log.level)">{{ log.level.toUpperCase() }}</span>
              <span class="mono text-ink-3 shrink-0">[{{ log.module }}]</span>
              <span class="text-xs text-ink-2 flex-1 break-all">{{ log.message }}</span>
              <span class="text-xs text-ink-4 shrink-0 amt">{{ formatLocalTime(log.created_at) }}</span>
            </div>
          </div>

          <div v-if="appLogsPagination.total > 50" class="flex items-center justify-between mt-4 pt-3 border-t border-rule">
            <span class="text-xs text-ink-3 amt">共 {{ appLogsPagination.total }} 条</span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn btn-outline btn-sm btn-icon"
                :disabled="appLogsPagination.page <= 1"
                @click="fetchAppLogs(appLogsPagination.page - 1)"
              ><AppIcon name="chevronLeft" :size="14" /></button>
              <span class="px-2 text-xs text-ink-2 amt">{{ appLogsPagination.page }}</span>
              <button
                type="button"
                class="btn btn-outline btn-sm btn-icon"
                @click="fetchAppLogs(appLogsPagination.page + 1)"
              ><AppIcon name="chevronRight" :size="14" /></button>
            </div>
          </div>
        </div>

        <!-- ───── 通知规则 ───── -->
        <div v-if="activeTab === 'rules'" class="space-y-6">
          <section>
            <div class="ledger-label mb-3">真源与发布</div>
            <div class="surface p-4">
              <p class="text-xs text-ink-2 leading-relaxed">
                规则内容真源是仓库文件 <code class="mono">server/config/rules.json</code>（改动走
                commit → 重启/重建，服务端启动时会校验并发布）。<br />
                本页只做<strong>查看历史版本</strong>与<strong>激活/回滚</strong>，<strong>不提供在线编辑</strong>——
                避免与文件双写、也避免发布一份与仓库不同的内容。详见 ARCHITECTURE §3.7。
              </p>
            </div>
          </section>

          <section>
            <div class="ledger-label mb-3">规则版本</div>
            <div v-if="loadingRules" class="text-center py-6 text-xs text-ink-3">加载中…</div>
            <EmptyState
              v-else-if="notifRules.length === 0"
              icon="code"
              title="暂无规则版本"
              description="在上方新建一个 JSON 规则版本，激活后用于通知自动记账解析。"
              compact
            />
            <div v-else class="space-y-2">
              <div
                v-for="rule in notifRules"
                :key="rule.id"
                class="admin-rule"
                :class="rule.is_active ? 'admin-rule-active' : ''"
              >
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <div class="text-sm font-medium text-ink-1">
                      版本 {{ rule.version }}
                      <span v-if="rule.is_active" class="badge badge-ink ml-1.5">当前激活</span>
                    </div>
                    <div class="text-xs text-ink-3 mt-0.5 amt">
                      {{ formatLocalTime(rule.created_at) }}
                      <span v-if="rule.content_hash" class="ml-2 mono">hash {{ String(rule.content_hash).slice(0, 12) }}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <button type="button" class="act" @click="openRulePreview(rule)">预览</button>
                    <button
                      v-if="!rule.is_active"
                      type="button"
                      class="act"
                      @click="activateRule(rule.id)"
                    >激活</button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
        <!-- ───── 自动化对照（客户端上报 vs 服务端入站预筛）───── -->
        <div v-if="activeTab === 'automation'" class="space-y-6">
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
                <div class="admin-stat" style="border-top-color: var(--color-action)">
                  <div class="admin-stat-num">{{ automationStats.client?.totals?.notifications ?? 0 }}</div>
                  <div class="admin-stat-label">通知总数</div>
                </div>
                <div class="admin-stat" style="border-top-color: var(--color-warn)">
                  <div class="admin-stat-num">{{ automationStats.client?.totals?.blocked ?? 0 }}</div>
                  <div class="admin-stat-label">拦下</div>
                </div>
                <div class="admin-stat" style="border-top-color: var(--color-info)">
                  <div class="admin-stat-num">{{ rateText(automationStats.client?.totals?.block_rate) }}</div>
                  <div class="admin-stat-label">拦截率</div>
                </div>
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
                <div class="admin-stat" style="border-top-color: var(--color-action)">
                  <div class="admin-stat-num">{{ funnel().received }}</div>
                  <div class="admin-stat-label">收到 received</div>
                </div>
                <div class="admin-stat" style="border-top-color: var(--color-warn)">
                  <div class="admin-stat-num">{{ funnel().dropped }}</div>
                  <div class="admin-stat-label">捕获层早退 dropped</div>
                </div>
                <div class="admin-stat" style="border-top-color: var(--color-expense)">
                  <div class="admin-stat-num">{{ funnel().unparsed_ai_failed }}</div>
                  <div class="admin-stat-label">AI 失败丢弃 unparsed</div>
                </div>
                <div class="admin-stat" style="border-top-color: var(--color-income)">
                  <div class="admin-stat-num">{{ funnelPassed() }}</div>
                  <div class="admin-stat-label">通过捕获层</div>
                </div>
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
        </div>

        <!-- ───── 未解析裁决（P1 列表 + P2 裁决）───── -->
        <div v-if="activeTab === 'triage'" class="space-y-6">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <span class="ledger-label ledger-label-solid">未解析裁决</span>
            <div class="flex items-center gap-2 flex-wrap">
              <select v-model="triageFilter.days" class="field w-auto" @change="fetchTriage()">
                <option value="1">今天</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
                <option value="90">近 90 天</option>
              </select>
              <select v-model="triageFilter.channel" class="field w-auto" @change="fetchTriage()">
                <option value="">全部渠道</option>
                <option value="nls">nls</option>
                <option value="sms">sms</option>
                <option value="a11y">a11y</option>
                <option value="manual">manual</option>
              </select>
              <select v-model="triageFilter.action" class="field w-auto" @change="fetchTriage()">
                <option value="">全部裁决状态</option>
                <option value="mark_bill">已判「是账」</option>
                <option value="mark_not_bill">已判「不是账」</option>
                <option value="mark_rule_missing">判据缺失（规则候选）</option>
              </select>
              <label class="flex items-center gap-1.5 text-xs text-ink-2 whitespace-nowrap">
                <input type="checkbox" v-model="triageFilter.includeRaw" @change="fetchTriage()" />
                显示原文（写审计）
              </label>
            </div>
          </div>

          <p class="text-xs text-ink-3 leading-relaxed">
            AI <b>失败 = 不确定</b>（客户端不落待审、不打扰用户，只在这里留痕）。默认只给<b>脱敏预览</b>（首 60 字）；
            勾选「显示原文」才取全文，且服务端会写审计。裁决<b>只落记录</b>：<b>不写账、不回推客户端</b>；
            「不是账 / 判据缺失」充当规则/语料候选池（最终改动仍走 <code>rules.json</code> 发布流程）。
          </p>

          <div v-if="loadingTriage" class="text-center py-8 text-xs text-ink-3">加载中…</div>
          <EmptyState
            v-else-if="!triageStats"
            icon="search"
            title="读不到未解析记录"
            description="服务端未返回数据，或窗口内没有 AI 不可用的失败记录。"
            compact
          />
          <template v-else>
            <section>
              <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div class="admin-stat" style="border-top-color: var(--color-action)">
                  <div class="admin-stat-num">{{ triageStats.summary.total }}</div>
                  <div class="admin-stat-label">窗口内失败总数</div>
                </div>
                <div
                  v-for="r in (triageStats.summary.by_failure_code ?? []).slice(0, 3)"
                  :key="r.failure_code"
                  class="admin-stat"
                  style="border-top-color: var(--color-warn)"
                >
                  <div class="admin-stat-num">{{ r.count }}</div>
                  <div class="admin-stat-label mono truncate">{{ r.failure_code }}</div>
                </div>
              </div>
              <div v-if="triageStats.summary.by_channel?.length" class="sheet mt-3">
                <div v-for="c in triageStats.summary.by_channel" :key="c.channel" class="sheet-row">
                  <span class="text-sm text-ink-1 w-16">{{ c.channel }}</span>
                  <span class="flex-1 text-xs text-ink-3 amt">{{ c.count }} 条</span>
                </div>
              </div>
            </section>

            <EmptyState
              v-if="triageStats.items.length === 0"
              icon="check"
              title="窗口内没有未解析失败"
              compact
            />
            <div v-else class="space-y-2">
              <div v-for="it in triageStats.items" :key="it.id" class="surface p-3">
                <div class="flex items-center gap-2 flex-wrap text-xs text-ink-3">
                  <span class="badge badge-warn">{{ it.failure_code }}</span>
                  <span v-if="it.channel" class="badge">{{ it.channel }}</span>
                  <span v-if="it.source_package" class="truncate max-w-40">{{ it.source_package }}</span>
                  <span class="amt">#{{ it.id }}</span>
                  <span>{{ formatLocalTime(it.created_at) }}</span>
                  <span v-if="it.attempts > 1">调模型 {{ it.attempts }} 次</span>
                </div>
                <div class="text-sm text-ink-1 mt-2 break-words">{{ it.raw_input ?? it.text_preview }}</div>
                <div v-if="!it.raw_input && it.raw_input_len > it.text_preview.length" class="text-xs text-ink-4 mt-1">
                  已脱敏（共 {{ it.raw_input_len }} 字）
                </div>
                <div v-if="it.triage" class="text-xs text-ink-3 mt-2">
                  当前裁决：<span class="badge badge-ink">{{ it.triage.action }}</span>
                  <span class="ml-1">{{ it.triage.reason }}</span>
                </div>
                <div class="flex items-center gap-2 mt-2 flex-wrap">
                  <input v-model="triageReasons[it.id]" class="field flex-1 min-w-40" placeholder="裁决理由（必填）" />
                  <button class="btn btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_bill')">是账</button>
                  <button class="btn btn-outline btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_not_bill')">不是账</button>
                  <button class="btn btn-outline btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_rule_missing')">判据缺失</button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- ───── App 更新（APK 自托管分发）───── -->
        <div v-if="activeTab === 'release'" class="space-y-6">
          <section>
            <div class="ledger-label mb-3">当前激活版本</div>
            <EmptyState
              v-if="!activeUpdate"
              icon="upload"
              title="服务端没有激活版本"
              description="客户端会回落到 GitHub Release；上传一个 APK 后即从服务端分发。"
              compact
            />
            <div v-else class="surface p-4">
              <div class="flex items-center justify-between gap-2">
                <div class="text-sm font-medium text-ink-1">
                  {{ activeUpdate.version_name }}
                  <span class="badge badge-ink ml-1.5">versionCode {{ activeUpdate.version_code }}</span>
                  <span v-if="activeUpdate.force_update" class="badge badge-warn ml-1.5">强制更新</span>
                </div>
                <span class="text-xs text-ink-3 amt">{{ formatBytes(activeUpdate.apk_size) }}</span>
              </div>
              <div v-if="activeUpdate.changelog" class="text-xs text-ink-2 mt-2 whitespace-pre-wrap">{{ activeUpdate.changelog }}</div>
              <div class="text-xs text-ink-4 mt-2 amt">{{ formatLocalTime(activeUpdate.created_at) }}</div>
            </div>
          </section>

          <section>
            <div class="ledger-label mb-3">上传新版本</div>
            <div class="surface p-4 space-y-3">
              <div>
                <label class="field-label">APK 文件</label>
                <input type="file" accept=".apk" class="field" @change="pickApk" />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="field-label">versionName</label>
                  <input v-model="apkForm.version_name" class="field" placeholder="例如：1.7.0" />
                </div>
                <div>
                  <label class="field-label">versionCode</label>
                  <input v-model="apkForm.version_code" class="field" inputmode="numeric" placeholder="例如：25" />
                </div>
              </div>
              <div>
                <label class="field-label">更新说明</label>
                <textarea v-model="apkForm.changelog" rows="2" class="field"></textarea>
              </div>
              <label class="flex items-center gap-2 text-sm text-ink-1">
                <input v-model="apkForm.force_update" type="checkbox" />
                强制更新（低于此 versionCode 的客户端会被要求升级）
              </label>
              <div class="text-xs text-ink-3">versionCode 必须**严格递增且唯一**（跳号正常）—— 见 ARCHITECTURE §3.8。</div>
              <button
                type="button"
                class="btn btn-primary btn-block"
                :disabled="uploadingApk || !apkFile || !apkForm.version_name || !apkForm.version_code"
                @click="uploadApk"
              >{{ uploadingApk ? '上传中…' : '上传并激活' }}</button>
            </div>
          </section>

          <section>
            <div class="ledger-label mb-3">版本历史（共 {{ appUpdatesTotal }} 个）</div>
            <div v-if="loadingUpdates" class="text-center py-6 text-xs text-ink-3">加载中…</div>
            <EmptyState
              v-else-if="appUpdates.length === 0"
              icon="upload"
              title="还没有上传过版本"
              description="上传后，已发布的 Android 客户端会发现更新。"
              compact
            />
            <div v-else class="sheet">
              <div v-for="u in appUpdates" :key="u.id" class="sheet-row">
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-ink-1">
                    {{ u.version_name }}
                    <span v-if="u.is_active" class="badge badge-ink ml-1.5">激活</span>
                    <span v-if="u.force_update" class="badge badge-warn ml-1.5">强制</span>
                  </div>
                  <div class="text-xs text-ink-3 mt-0.5 amt">code {{ u.version_code }} · {{ formatBytes(u.apk_size) }} · {{ formatLocalTime(u.created_at) }}</div>
                </div>
              </div>
            </div>
            <div v-if="appUpdatesTotal > appUpdatesPageSize" class="flex items-center justify-between mt-4 pt-3 border-t border-rule">
              <span class="text-xs text-ink-3 amt">共 {{ appUpdatesTotal }} 条</span>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="btn btn-outline btn-sm btn-icon"
                  :disabled="appUpdatesPage <= 1"
                  @click="fetchAppUpdates(appUpdatesPage - 1)"
                ><AppIcon name="chevronLeft" :size="14" /></button>
                <span class="px-2 text-xs text-ink-2 amt">{{ appUpdatesPage }} / {{ Math.ceil(appUpdatesTotal / appUpdatesPageSize) }}</span>
                <button
                  type="button"
                  class="btn btn-outline btn-sm btn-icon"
                  :disabled="appUpdatesPage >= Math.ceil(appUpdatesTotal / appUpdatesPageSize)"
                  @click="fetchAppUpdates(appUpdatesPage + 1)"
                ><AppIcon name="chevronRight" :size="14" /></button>
              </div>
            </div>
          </section>
        </div>

      </div>
    </div>

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
          <span v-if="showParseDetail.user_modified" class="badge badge-warn">已修正</span>
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

        <div v-if="showParseDetail.modification_detail" class="admin-stage">
          <div class="admin-stage-label">修正详情</div>
          <pre class="admin-stage-box admin-stage-warn mono scroll-thin admin-stage-scroll">{{ showParseDetail.modification_detail }}</pre>
        </div>

        <div v-if="showParseDetail.error_message" class="admin-stage">
          <div class="admin-stage-label">错误信息</div>
          <div class="admin-stage-box admin-stage-expense">{{ showParseDetail.error_message }}</div>
        </div>
      </div>
    </BaseModal>

    <!-- 用户账单明细 BaseModal -->
    <BaseModal
      :show="!!viewingUserId"
      title="用户账单明细"
      size="xl"
      @close="closeUserTransactions"
    >
      <div v-if="userTransactionsLoading" class="text-center py-8 text-sm text-ink-3">加载中…</div>
      <EmptyState
        v-else-if="userTransactions.length === 0"
        icon="inbox"
        title="暂无交易记录"
        description="该用户还没有任何流水。"
        compact
      />
      <div v-else class="sheet">
        <div v-for="tx in userTransactions" :key="tx.id" class="sheet-row">
          <span class="tx-icon">{{ tx.category_icon || '📦' }}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-ink-1 truncate">{{ tx.description || '-' }}</div>
            <div class="text-xs text-ink-3 truncate">{{ tx.date }} · {{ tx.category_name || '-' }} · {{ tx.account_name || '-' }}</div>
          </div>
          <span v-if="tx.source" class="hidden md:inline badge">{{ tx.source }}</span>
          <Money
            :value="tx.amount"
            size="sm"
            :tone="tx.type === 'expense' ? 'expense' : 'income'"
            :sign="tx.type === 'expense' ? 'minus' : 'plus'"
            absolute
          />
        </div>
      </div>

      <div v-if="userTxTotal > 20" class="flex items-center justify-center gap-2 mt-4">
        <button
          type="button"
          class="btn btn-outline btn-sm"
          :disabled="userTxPage <= 1"
          @click="fetchUserTransactions(viewingUserId!, userTxPage - 1)"
        >上一页</button>
        <span class="text-xs text-ink-3 amt">{{ userTxPage }} / {{ Math.ceil(userTxTotal / 20) }}</span>
        <button
          type="button"
          class="btn btn-outline btn-sm"
          :disabled="userTxPage >= Math.ceil(userTxTotal / 20)"
          @click="fetchUserTransactions(viewingUserId!, userTxPage + 1)"
        >下一页</button>
      </div>
    </BaseModal>

    <!-- 规则版本预览（与解析详情/用户明细同一种详情面） -->
    <BaseModal
      :show="!!showRulePreview"
      :title="showRulePreview ? `规则版本 ${showRulePreview.version}` : '规则版本'"
      size="lg"
      @close="showRulePreview = null"
    >
      <div v-if="showRulePreview" class="space-y-3">
        <div class="flex items-center gap-2 text-xs text-ink-3 amt">
          <span v-if="showRulePreview.is_active" class="badge badge-ink">当前激活</span>
          <span v-if="showRulePreview.content_hash" class="mono truncate">
            content_hash {{ showRulePreview.content_hash }}
          </span>
          <span class="ml-auto shrink-0">{{ formatLocalTime(showRulePreview.created_at) }}</span>
        </div>
        <pre class="admin-json-view scroll-thin mono">{{ formatRuleJson(showRulePreview) }}</pre>
      </div>
    </BaseModal>
  </div>
</template>

<style scoped>
.admin-nav { position: sticky; top: 1.5rem; }
.admin-nav-group {
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--color-ink-4);
  padding: 0 0 0.25rem 0.625rem;
}
.admin-nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border-left: 2px solid transparent;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-ink-3);
  text-align: left;
  transition: color 0.13s ease, background-color 0.13s ease, border-color 0.13s ease;
}
.admin-nav-item:hover { color: var(--color-ink-1); background: var(--color-paper-hover); }
.admin-nav-item-active {
  border-left-color: var(--color-ink-1);
  color: var(--color-ink-1);
  background: var(--color-paper-hover);
}

/* 指标格：白底 + 顶部 2px 语义色条 + 等宽大数字 */
.admin-stat {
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-top: 2px solid var(--color-rule);
  border-radius: var(--radius-sm);
  padding: 0.875rem;
  text-align: center;
}
.admin-stat-num {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--color-ink-1);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.admin-stat-label {
  font-size: 0.6875rem;
  color: var(--color-ink-3);
  margin-top: 0.25rem;
}

.admin-avatar {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  color: var(--color-ink-1);
  font-size: 0.75rem;
  font-weight: 650;
}

.admin-detail {
  padding: 1rem 0.875rem;
  background: var(--color-paper-sunk);
  border-top: 1px solid var(--color-rule);
}
.admin-mini {
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  padding: 0.625rem;
  text-align: center;
}
.admin-mini-num {
  font-size: 1.125rem;
  font-weight: 650;
  color: var(--color-ink-1);
}

/* 邀请码：等宽 + 宽字距 */
.admin-code {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--color-ink-1);
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-xs);
  padding: 0.1875rem 0.5rem;
}

/* 质量筛选 chip：选中态语义色 */
.qa-chip-income {
  background: var(--color-income);
  border-color: var(--color-income);
  color: var(--color-on-tone);
}
.qa-chip-warn {
  background: var(--color-warn);
  border-color: var(--color-warn);
  color: var(--color-on-tone);
}
.qa-chip-expense {
  background: var(--color-expense);
  border-color: var(--color-expense);
  color: var(--color-on-tone);
}

/* 日志行 */
.admin-log-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--color-rule-faint);
}
.admin-log-row:first-child { border-top: 0; }

/* JSON 编辑器 */
.admin-json {
  resize: vertical;
  min-height: 9rem;
  line-height: 1.5;
}
.admin-json-view {
  margin-top: 0.5rem;
  padding: 0.75rem;
  max-height: 15rem;
  overflow: auto;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  color: var(--color-ink-2);
  white-space: pre;
}

/* 规则版本行：当前激活墨色描边 */
.admin-rule {
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  padding: 0.75rem 0.875rem;
}
.admin-rule-active { border-color: var(--color-ink-1); }

/* 解析详情各阶段 */
.admin-stage-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-ink-3);
  margin-bottom: 0.375rem;
}
.admin-stage-box {
  padding: 0.75rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-rule);
  font-size: 0.8125rem;
  color: var(--color-ink-1);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.admin-stage-scroll { max-height: 10rem; overflow: auto; font-size: 0.75rem; }
.admin-stage-plain { background: var(--color-paper-sunk); }
.admin-stage-info { background: var(--color-info-soft); border-color: var(--color-info-line); }
.admin-stage-income { background: var(--color-income-soft); border-color: var(--color-income-line); }
.admin-stage-warn { background: var(--color-warn-soft); border-color: var(--color-warn-line); }
.admin-stage-expense { background: var(--color-expense-soft); border-color: var(--color-expense-line); color: var(--color-expense); }
</style>
