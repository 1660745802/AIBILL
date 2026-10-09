<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import api from '@/api/index'
import BaseModal from '@/components/ui/BaseModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const auth = useAuthStore()
const toast = useToast()
const confirm = useConfirm()

type TabKey = 'overview' | 'users' | 'codes' | 'ai' | 'quality' | 'logs' | 'rules'

// Tab navigation
const activeTab = ref<TabKey>('overview')

const navItems: { key: TabKey; label: string; short: string; icon: string }[] = [
  { key: 'overview', label: '概览', short: '概览', icon: 'overview' },
  { key: 'users', label: '用户管理', short: '用户', icon: 'users' },
  { key: 'codes', label: '邀请码', short: '邀请码', icon: 'ticket' },
  { key: 'ai', label: 'AI 设置', short: 'AI', icon: 'spark' },
  { key: 'quality', label: '解析质量', short: '质量', icon: 'search' },
  { key: 'logs', label: '系统日志', short: '日志', icon: 'list' },
  { key: 'rules', label: '通知规则', short: '规则', icon: 'code' },
]

function switchTab(key: TabKey) {
  activeTab.value = key
  if (key === 'logs') fetchAppLogs()
  if (key === 'rules') fetchNotifRules()
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
const previewRuleId = ref<number | null>(null)
const newRuleVersion = ref('')
const newRuleContent = ref('')
const savingRule = ref(false)

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
  if (auth.isAdmin) {
    await fetchAdminData()
    fetchSystemStats()
  }
})

async function fetchAdminData() {
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
  } catch { /* ignore */ }
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
  } catch { toast.error('重置失败') }
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
  } catch { toast.error('删除失败') }
}

async function saveSettings() {
  try {
    await api.put('/admin/settings', globalSettings.value)
    toast.success('设置已保存')
  } catch { /* ignore */ }
}

async function fetchParseStats() {
  try {
    const { data } = await api.get('/admin/ai-parse-stats', {
      params: { days: parseLogsFilter.value.days },
    })
    if (data.code === 0) parseStats.value = data.data
  } catch { /* ignore */ }
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
      parseLogs.value = data.data.items
      parseLogsPagination.value = data.data.pagination
    }
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

// === 应用日志 ===
async function fetchAppLogs(page = 1) {
  loadingAppLogs.value = true
  try {
    const params: any = { page, page_size: appLogsPagination.value.page_size, days: appLogsFilter.value.days }
    if (appLogsFilter.value.level) params.level = appLogsFilter.value.level
    if (appLogsFilter.value.module) params.module = appLogsFilter.value.module
    const { data } = await api.get('/admin/logs', { params })
    if (data.code === 0) {
      appLogs.value = data.data.items
      appLogsPagination.value = data.data.pagination
    }
  } catch { /* ignore */ }
  finally { loadingAppLogs.value = false }
}

function logLevelBadge(level: string): string {
  const map: Record<string, string> = { info: 'badge-info', warn: 'badge-warn', error: 'badge-expense' }
  return map[level] || 'badge'
}

// === 通知规则 ===
async function fetchNotifRules() {
  loadingRules.value = true
  try {
    const { data } = await api.get('/admin/notification-rules')
    if (data.code === 0) notifRules.value = data.data.items
  } catch { /* ignore */ }
  finally { loadingRules.value = false }
}

async function activateRule(id: number) {
  try {
    const { data } = await api.put(`/admin/notification-rules/${id}/activate`)
    if (data.code === 0) {
      toast.success(data.message)
      await fetchNotifRules()
    }
  } catch { toast.error('激活失败') }
}

async function createRule() {
  const version = Number(newRuleVersion.value)
  if (!version || version <= 0) {
    toast.error('版本号需为正整数')
    return
  }
  let rules: any
  try {
    rules = JSON.parse(newRuleContent.value)
  } catch {
    toast.error('JSON 格式错误')
    return
  }
  savingRule.value = true
  try {
    const { data } = await api.post('/admin/notification-rules', { version, rules })
    if (data.code === 0) {
      toast.success('规则版本已创建')
      newRuleVersion.value = ''
      newRuleContent.value = ''
      await fetchNotifRules()
    } else {
      toast.error(data.message)
    }
  } catch { toast.error('创建失败') }
  finally { savingRule.value = false }
}

function togglePreview(id: number) {
  previewRuleId.value = previewRuleId.value === id ? null : id
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
  } catch { toast.error('获取账单失败') }
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
          <nav class="flex flex-col">
            <button
              v-for="item in navItems"
              :key="item.key"
              type="button"
              class="admin-nav-item"
              :class="activeTab === item.key ? 'admin-nav-item-active' : ''"
              @click="switchTab(item.key)"
            >
              <AppIcon :name="item.icon" :size="16" />
              <span>{{ item.label }}</span>
            </button>
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

        <!-- ───── 概览 ───── -->
        <div v-if="activeTab === 'overview'" class="space-y-6">
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
        </div>

        <!-- ───── 邀请码 ───── -->
        <div v-if="activeTab === 'codes'">
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
            <div class="ledger-label mb-3">新建版本</div>
            <div class="surface p-4 space-y-3">
              <div>
                <label class="field-label">版本号</label>
                <input v-model="newRuleVersion" type="number" min="1" class="field" placeholder="例如：2" />
              </div>
              <div>
                <label class="field-label">规则内容（JSON）</label>
                <textarea
                  v-model="newRuleContent"
                  rows="6"
                  class="field mono admin-json"
                  placeholder='{ "nls": [...], "source_mapping": {...}, "processor": {...} }'
                ></textarea>
              </div>
              <button
                type="button"
                class="btn btn-primary btn-block"
                :disabled="savingRule || !newRuleVersion || !newRuleContent"
                @click="createRule"
              >{{ savingRule ? '保存中…' : '保存规则' }}</button>
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
                    <div class="text-xs text-ink-3 mt-0.5">{{ formatLocalTime(rule.created_at) }}</div>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <button type="button" class="act" @click="togglePreview(rule.id)">
                      {{ previewRuleId === rule.id ? '收起' : '预览' }}
                    </button>
                    <button
                      v-if="!rule.is_active"
                      type="button"
                      class="act"
                      @click="activateRule(rule.id)"
                    >激活</button>
                  </div>
                </div>
                <pre v-if="previewRuleId === rule.id" class="admin-json-view scroll-thin mono">{{ formatRuleJson(rule) }}</pre>
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
  </div>
</template>

<style scoped>
.admin-nav { position: sticky; top: 1.5rem; }
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
  font-size: 1.5rem;
  font-weight: 650;
  color: var(--color-ink-1);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
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
