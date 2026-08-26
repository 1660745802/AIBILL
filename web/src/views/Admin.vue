<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import api from '@/api/index'

const auth = useAuthStore()
const toast = useToast()

// Tab navigation
const activeTab = ref<'overview' | 'users' | 'codes' | 'ai' | 'quality' | 'logs' | 'rules'>('overview')

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

async function revokeCode(id: number) {
  if (!confirm('确定作废此邀请码？')) return
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
  if (!confirm(`确定删除用户 ${username}？此操作将清除该用户所有数据且不可恢复！`)) return
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

function statusLabel(status: string): string {
  const map: Record<string, string> = { success: '✅ 成功', empty: '⚠️ 空结果', error: '❌ 错误', timeout: '⏱️ 超时' }
  return map[status] || status
}

function statusColor(status: string): string {
  const map: Record<string, string> = { success: 'text-green-600', empty: 'text-yellow-600', error: 'text-red-600', timeout: 'text-orange-600' }
  return map[status] || 'text-gray-600'
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

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>


<template>
  <div class="pb-20 md:pb-4">
    <!-- 管理面板：左侧菜单 + 右侧内容 -->
    <div class="flex flex-col md:flex-row gap-0 md:gap-5">
      <!-- 左侧菜单 (PC 显示为固定侧栏，移动端显示为横向滚动) -->
      <aside class="hidden md:block md:w-44 lg:w-48 shrink-0">
        <div class="sticky top-6">
          <h1 class="page-title mb-1">管理面板</h1>
          <p class="page-subtitle mb-4">系统管理和监控</p>
          <nav class="space-y-0.5">
            <button
              v-for="tab in [
                { key: 'overview', label: '概览', icon: '📋' },
                { key: 'users', label: '用户管理', icon: '👥' },
                { key: 'codes', label: '邀请码', icon: '🎟️' },
                { key: 'ai', label: 'AI 设置', icon: '🤖' },
                { key: 'quality', label: '解析质量', icon: '🔍' },
                { key: 'logs', label: '系统日志', icon: '📜' },
                { key: 'rules', label: '通知规则', icon: '📱' },
              ]"
              :key="tab.key"
              @click="activeTab = tab.key as any; tab.key === 'logs' && fetchAppLogs(); tab.key === 'rules' && fetchNotifRules()"
              class="w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2"
              :style="activeTab === tab.key
                ? 'background: var(--color-primary-50); color: var(--color-primary-700)'
                : 'color: var(--color-text-secondary)'"
            >
              <span class="text-sm">{{ tab.icon }}</span>
              <span>{{ tab.label }}</span>
            </button>
          </nav>
        </div>
      </aside>

      <!-- 移动端：横向 Tab (仅 md 以下显示) -->
      <div class="md:hidden mb-4">
        <h1 class="page-title mb-3">管理面板</h1>
        <div class="flex gap-1.5 overflow-x-auto pb-1">
          <button
            v-for="tab in [
              { key: 'overview', label: '概览' },
              { key: 'users', label: '用户' },
              { key: 'codes', label: '邀请码' },
              { key: 'ai', label: 'AI' },
              { key: 'quality', label: '质量' },
              { key: 'logs', label: '日志' },
              { key: 'rules', label: '规则' },
            ]"
            :key="tab.key"
            @click="activeTab = tab.key as any; tab.key === 'logs' && fetchAppLogs(); tab.key === 'rules' && fetchNotifRules()"
            class="px-3 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap"
            :style="activeTab === tab.key
              ? 'background: var(--color-primary-600); color: white'
              : 'background: var(--color-primary-50); color: var(--color-text-secondary)'"
          >{{ tab.label }}</button>
        </div>
      </div>

      <!-- 右侧内容区 -->
      <div class="flex-1 min-w-0">

    <!-- Tab 0: 系统概览 -->
    <div v-if="activeTab === 'overview'" class="space-y-3">
      <div v-if="systemStats" class="grid grid-cols-2 gap-3">
        <div class="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4 text-center">
          <div class="text-2xl font-bold text-blue-700">{{ systemStats.totalUsers }}</div>
          <div class="text-xs text-blue-500 mt-1">注册用户</div>
        </div>
        <div class="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-4 text-center">
          <div class="text-2xl font-bold text-green-700">{{ systemStats.activeUsers }}</div>
          <div class="text-xs text-green-500 mt-1">活跃用户</div>
        </div>
        <div class="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4 text-center">
          <div class="text-2xl font-bold text-purple-700">{{ systemStats.totalTransactions }}</div>
          <div class="text-xs text-purple-500 mt-1">总交易笔数</div>
        </div>
        <div class="bg-gradient-to-br from-amber-50 to-amber-100 rounded-xl p-4 text-center">
          <div class="text-2xl font-bold text-amber-700">{{ systemStats.todayLogs }}</div>
          <div class="text-xs text-amber-500 mt-1">今日日志</div>
        </div>
      </div>

      <!-- 用户列表快览 -->
      <div class="bg-white rounded-xl border border-gray-100 p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">用户一览</h3>
        <div class="space-y-2">
          <div v-for="u in users" :key="u.id" class="flex items-center justify-between text-sm">
            <div class="flex items-center gap-2">
              <span class="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs">{{ (u.nickname || u.username)?.[0] }}</span>
              <div>
                <span class="text-gray-800">{{ u.nickname || u.username }}</span>
                <span v-if="u.role === 'admin'" class="ml-1 text-[10px] bg-blue-100 text-blue-600 px-1 rounded">管理员</span>
              </div>
            </div>
            <span class="text-xs text-gray-400">{{ u.transaction_count }} 笔</span>
          </div>
        </div>
      </div>

      <!-- 最近解析质量 -->
      <div v-if="parseStats" class="bg-white rounded-xl border border-gray-100 p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">AI 解析质量（近30天）</h3>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div>
            <div class="text-lg font-semibold text-gray-800">{{ parseStats.overview.total }}</div>
            <div class="text-[10px] text-gray-400">总调用</div>
          </div>
          <div>
            <div class="text-lg font-semibold text-green-600">{{ parseStats.overview.success_rate }}%</div>
            <div class="text-[10px] text-gray-400">成功率</div>
          </div>
          <div>
            <div class="text-lg font-semibold text-orange-600">{{ parseStats.modification?.modification_rate || 0 }}%</div>
            <div class="text-[10px] text-gray-400">修正率</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 1: 用户管理 -->
    <div v-if="activeTab === 'users'" class="space-y-3">
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <span class="text-lg">👥</span>
          <h3 class="text-sm font-semibold text-gray-800">用户管理</h3>
          <span class="text-xs text-gray-400 ml-auto">{{ users.length }} 人</span>
        </div>
        <div class="px-3 py-3">
          <div class="space-y-1">
            <div
              v-for="u in users"
              :key="u.id"
              class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div class="flex items-center gap-3 cursor-pointer flex-1 min-w-0" @click="viewUserDetail(u.id)">
                <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-sm font-medium text-blue-600">
                  {{ (u.nickname || u.username)[0].toUpperCase() }}
                </div>
                <div>
                  <div class="text-sm font-medium text-gray-800">
                    {{ u.nickname || u.username }}
                    <span v-if="u.role === 'admin'" class="ml-1 text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full">管理员</span>
                  </div>
                  <div class="text-xs text-gray-400">{{ u.transaction_count }} 笔 · {{ formatLocalTime(u.created_at) }}</div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  @click.stop="fetchUserTransactions(u.id)"
                  class="text-xs px-2 py-1 rounded-lg font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                >账单</button>
                <button
                  v-if="u.id !== auth.user?.id"
                  @click="toggleUser(u.id, u.is_active)"
                  class="text-xs px-2.5 py-1 rounded-lg font-medium transition-colors"
                  :class="u.is_active ? 'text-red-600 bg-red-50 hover:bg-red-100' : 'text-green-600 bg-green-50 hover:bg-green-100'"
                >
                  {{ u.is_active ? '禁用' : '启用' }}
                </button>
                <span v-else class="text-xs text-gray-300">当前</span>
              </div>
            </div>
          </div>

          <!-- 用户详情弹出层 -->
          <div v-if="showUserDetail" class="mt-3 border-t border-gray-100 pt-4">
            <div class="flex items-center justify-between mb-3">
              <h4 class="text-sm font-semibold text-gray-700">📋 {{ showUserDetail.nickname || showUserDetail.username }} 的信息</h4>
              <button @click="showUserDetail = null" class="text-xs text-gray-400 hover:text-gray-600">✕ 关闭</button>
            </div>
            <div v-if="userStats" class="grid grid-cols-3 gap-3 mb-4">
              <div class="bg-gray-50 rounded-lg p-2.5 text-center">
                <div class="text-lg font-semibold text-gray-800">{{ userStats.total_transactions }}</div>
                <div class="text-[10px] text-gray-400">总笔数</div>
              </div>
              <div class="bg-gray-50 rounded-lg p-2.5 text-center">
                <div class="text-lg font-semibold text-red-500">¥{{ (userStats.total_expense / 100).toFixed(0) }}</div>
                <div class="text-[10px] text-gray-400">总支出</div>
              </div>
              <div class="bg-gray-50 rounded-lg p-2.5 text-center">
                <div class="text-lg font-semibold text-green-500">¥{{ (userStats.total_income / 100).toFixed(0) }}</div>
                <div class="text-[10px] text-gray-400">总收入</div>
              </div>
            </div>
            <div class="space-y-2">
              <div class="flex flex-col sm:flex-row gap-2">
                <input
                  v-model="newPasswordInput"
                  type="text"
                  class="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  placeholder="输入新密码（≥6位）"
                />
                <button
                  @click="resetPasswordId = showUserDetail.id; resetPassword()"
                  class="px-3 py-1.5 text-sm font-medium text-orange-600 bg-orange-50 rounded-lg hover:bg-orange-100 transition-colors whitespace-nowrap"
                >
                  🔑 重置密码
                </button>
              </div>
              <button
                v-if="showUserDetail.id !== auth.user?.id"
                @click="deleteUser(showUserDetail.id, showUserDetail.username)"
                class="w-full py-2 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
              >
                🗑️ 删除用户（不可恢复）
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 2: 邀请码管理 -->
    <div v-if="activeTab === 'codes'" class="space-y-3">
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <span class="text-lg">🎟️</span>
          <h3 class="text-sm font-semibold text-gray-800">邀请码管理</h3>
        </div>
        <div class="px-3 py-3">
          <div class="flex flex-wrap items-center gap-3 mb-4">
            <div class="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <input
                v-model.number="newCodeMaxUses"
                type="number"
                min="1"
                max="100"
                class="w-14 px-2 py-1 border border-gray-200 rounded-md text-sm text-center focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <span class="text-xs text-gray-500">次可用</span>
            </div>
            <button
              @click="generateCode"
              :disabled="generating"
              class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {{ generating ? '生成中...' : '✨ 生成邀请码' }}
            </button>
          </div>
          <div class="space-y-2 max-h-48 overflow-y-auto">
            <div
              v-for="code in inviteCodes"
              :key="code.id"
              class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 bg-gray-50 rounded-lg"
            >
              <div class="flex items-center gap-3">
                <span class="font-mono text-sm font-semibold text-gray-800 bg-white px-2 py-0.5 rounded border border-gray-200">{{ code.code }}</span>
                <span class="text-xs text-gray-400">已用 {{ code.used_count }}/{{ code.max_uses }}</span>
              </div>
              <button
                v-if="code.used_count < code.max_uses"
                @click="revokeCode(code.id)"
                class="text-xs px-2.5 py-1 text-red-500 bg-red-50 rounded-md hover:bg-red-100 transition-colors"
              >
                作废
              </button>
              <span v-else class="text-xs px-2.5 py-1 text-gray-400 bg-gray-100 rounded-md">已用完</span>
            </div>
            <div v-if="inviteCodes.length === 0" class="text-center py-4 text-xs text-gray-400">
              暂无邀请码，点击上方按钮生成
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 3: AI 设置 -->
    <div v-if="activeTab === 'ai'" class="space-y-3">
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <span class="text-lg">🤖</span>
          <h3 class="text-sm font-semibold text-gray-800">AI 模型配置</h3>
        </div>
        <div class="px-5 py-4 space-y-4">
          <div>
            <label class="text-xs font-medium text-gray-600 mb-1 block">API 地址</label>
            <input
              v-model="globalSettings.ai_base_url"
              type="text"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow"
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div>
            <label class="text-xs font-medium text-gray-600 mb-1 block">API Key</label>
            <input
              v-model="globalSettings.ai_api_key"
              type="password"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow"
              placeholder="sk-..."
            />
          </div>
          <div>
            <label class="text-xs font-medium text-gray-600 mb-1 block">模型名称</label>
            <input
              v-model="globalSettings.ai_model"
              type="text"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow"
              placeholder="gpt-4o-mini"
            />
          </div>
          <button
            @click="saveSettings"
            class="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            💾 保存设置
          </button>
        </div>
      </div>
    </div>

    <!-- Tab 4: 质量监控 -->
    <div v-if="activeTab === 'quality'" class="space-y-3">
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-lg">🔍</span>
            <h3 class="text-sm font-semibold text-gray-800">AI 解析质量</h3>
          </div>
          <select
            v-model="parseLogsFilter.days"
            @change="fetchParseStats(); fetchParseLogs(1)"
            class="px-2 py-1 border border-gray-200 rounded-lg text-xs text-gray-600 bg-gray-50 focus:outline-none"
          >
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
            <option value="365">近一年</option>
          </select>
        </div>

        <div class="px-3 py-3">
          <!-- 指标卡片 -->
          <div v-if="parseStats" class="grid grid-cols-4 gap-2 mb-4">
            <div class="rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 p-3 text-center">
              <div class="text-xl font-bold text-blue-700">{{ parseStats.overview.total }}</div>
              <div class="text-[10px] text-blue-500 mt-0.5">总调用</div>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100 p-3 text-center">
              <div class="text-xl font-bold text-emerald-700">{{ parseStats.overview.success_rate }}%</div>
              <div class="text-[10px] text-emerald-500 mt-0.5">成功率</div>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-violet-50 to-violet-100 p-3 text-center">
              <div class="text-xl font-bold text-violet-700">{{ formatDuration(parseStats.overview.avg_duration_ms) }}</div>
              <div class="text-[10px] text-violet-500 mt-0.5">平均耗时</div>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-amber-50 to-amber-100 p-3 text-center">
              <div class="text-xl font-bold text-amber-700">{{ parseStats.modification.modification_rate }}%</div>
              <div class="text-[10px] text-amber-500 mt-0.5">修正率</div>
            </div>
          </div>

          <!-- 状态筛选 -->
          <div class="flex gap-1.5 mb-3 overflow-x-auto pb-1">
            <button
              @click="parseLogsFilter.status = ''; fetchParseLogs(1)"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              :class="parseLogsFilter.status === '' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
            >全部</button>
            <button
              @click="parseLogsFilter.status = 'success'; fetchParseLogs(1)"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              :class="parseLogsFilter.status === 'success' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'"
            >✓ 成功</button>
            <button
              @click="parseLogsFilter.status = 'empty'; fetchParseLogs(1)"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              :class="parseLogsFilter.status === 'empty' ? 'bg-yellow-500 text-white' : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'"
            >○ 空结果</button>
            <button
              @click="parseLogsFilter.status = 'error'; fetchParseLogs(1)"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              :class="parseLogsFilter.status === 'error' ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 hover:bg-red-100'"
            >✕ 错误</button>
            <button
              @click="parseLogsFilter.status = 'timeout'; fetchParseLogs(1)"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              :class="parseLogsFilter.status === 'timeout' ? 'bg-orange-600 text-white' : 'bg-orange-50 text-orange-700 hover:bg-orange-100'"
            >⏱ 超时</button>
          </div>

          <!-- 日志列表 -->
          <div class="space-y-2 max-h-96 overflow-y-auto">
            <div v-if="loadingParseLogs" class="flex items-center justify-center py-8">
              <div class="w-5 h-5 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin"></div>
              <span class="ml-2 text-xs text-gray-400">加载中...</span>
            </div>
            <div v-else-if="parseLogs.length === 0" class="text-center py-8 text-xs text-gray-400">
              暂无解析记录
            </div>
            <div
              v-for="log in parseLogs"
              :key="log.id"
              @click="viewParseDetail(log)"
              class="group border border-gray-100 rounded-xl p-3 cursor-pointer hover:border-blue-200 hover:shadow-sm transition-all"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-800 truncate leading-snug">{{ log.raw_input }}</div>
                  <div class="flex items-center gap-2 mt-1.5">
                    <span
                      class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                      :class="{
                        'bg-emerald-50 text-emerald-700': log.status === 'success',
                        'bg-yellow-50 text-yellow-700': log.status === 'empty',
                        'bg-red-50 text-red-700': log.status === 'error',
                        'bg-orange-50 text-orange-700': log.status === 'timeout',
                      }"
                    >{{ statusLabel(log.status) }}</span>
                    <span class="text-[10px] text-gray-400">{{ log.username }}</span>
                    <span class="text-[10px] text-gray-400">{{ formatDuration(log.duration_ms) }}</span>
                    <span v-if="log.user_modified" class="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 text-[10px] font-medium">已修正</span>
                  </div>
                </div>
                <div class="text-[10px] text-gray-300 group-hover:text-blue-400 shrink-0 pt-0.5">
                  {{ formatLocalTime(log.created_at) }} ›
                </div>
              </div>
            </div>
          </div>

          <!-- 分页 -->
          <div v-if="parseLogsPagination.total_pages > 1" class="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
            <span class="text-[10px] text-gray-400">共 {{ parseLogsPagination.total }} 条</span>
            <div class="flex items-center gap-1">
              <button
                :disabled="parseLogsPagination.page <= 1"
                @click="fetchParseLogs(parseLogsPagination.page - 1)"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-xs border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
              >‹</button>
              <span class="px-2 text-xs text-gray-600">{{ parseLogsPagination.page }} / {{ parseLogsPagination.total_pages }}</span>
              <button
                :disabled="parseLogsPagination.page >= parseLogsPagination.total_pages"
                @click="fetchParseLogs(parseLogsPagination.page + 1)"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-xs border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
              >›</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 解析日志详情弹窗 -->
    <div
      v-if="showParseDetail"
      class="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center"
      @click.self="closeParseDetail"
    >
      <div class="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 class="text-base font-semibold text-gray-800">解析详情</h3>
            <span class="text-[10px] text-gray-400">#{{ showParseDetail.id }} · {{ formatLocalTime(showParseDetail.created_at) }}</span>
          </div>
          <button @click="closeParseDetail" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">✕</button>
        </div>

        <div class="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          <div class="flex items-center gap-3 p-3 rounded-xl bg-gray-50">
            <span class="text-sm font-medium" :class="statusColor(showParseDetail.status)">{{ statusLabel(showParseDetail.status) }}</span>
            <span class="text-[11px] text-gray-500">用户 {{ showParseDetail.username }} · 耗时 {{ formatDuration(showParseDetail.duration_ms) }}</span>
            <span v-if="showParseDetail.user_modified" class="text-[11px] text-amber-600 font-medium">· 已修正</span>
          </div>

          <div>
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">用户输入</div>
            <div class="bg-gray-50 border border-gray-100 p-3 rounded-xl text-sm text-gray-800 leading-relaxed">{{ showParseDetail.raw_input }}</div>
          </div>

          <div v-if="showParseDetail.cleaned_input && showParseDetail.cleaned_input !== showParseDetail.raw_input">
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">清洗后</div>
            <div class="bg-blue-50 border border-blue-100 p-3 rounded-xl text-sm text-gray-800 leading-relaxed">{{ showParseDetail.cleaned_input }}</div>
          </div>

          <div v-if="showParseDetail.ai_response">
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">AI 返回</div>
            <div class="bg-gray-50 border border-gray-100 p-3 rounded-xl font-mono text-[11px] text-gray-700 max-h-36 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{{ showParseDetail.ai_response }}</div>
          </div>

          <div v-if="showParseDetail.parsed_items">
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">解析结果</div>
            <div class="bg-emerald-50 border border-emerald-100 p-3 rounded-xl font-mono text-[11px] text-gray-700 max-h-36 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{{ showParseDetail.parsed_items }}</div>
          </div>

          <div v-if="showParseDetail.final_items">
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">最终提交</div>
            <div class="bg-amber-50 border border-amber-100 p-3 rounded-xl font-mono text-[11px] text-gray-700 max-h-36 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{{ showParseDetail.final_items }}</div>
          </div>

          <div v-if="showParseDetail.modification_detail">
            <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">修正详情</div>
            <div class="bg-yellow-50 border border-yellow-100 p-3 rounded-xl font-mono text-[11px] text-gray-700 whitespace-pre-wrap break-all leading-relaxed">{{ showParseDetail.modification_detail }}</div>
          </div>

          <div v-if="showParseDetail.error_message">
            <div class="text-[11px] font-medium text-red-500 uppercase tracking-wide mb-1.5">错误信息</div>
            <div class="bg-red-50 border border-red-100 p-3 rounded-xl text-sm text-red-700 leading-relaxed">{{ showParseDetail.error_message }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 5: 应用日志 -->
    <div v-if="activeTab === 'logs'" class="space-y-3">
      <div class="bg-white rounded-xl border border-gray-100 p-4">
        <!-- 筛选 -->
        <div class="flex gap-2 mb-3 flex-wrap">
          <select v-model="appLogsFilter.level" @change="fetchAppLogs(1)" class="px-2 py-1 border border-gray-200 rounded-lg text-xs">
            <option value="">全部级别</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>
          <select v-model="appLogsFilter.days" @change="fetchAppLogs(1)" class="px-2 py-1 border border-gray-200 rounded-lg text-xs">
            <option value="1">今天</option>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
          </select>
          <input v-model="appLogsFilter.module" @change="fetchAppLogs(1)" placeholder="模块名" class="px-2 py-1 border border-gray-200 rounded-lg text-xs w-24" />
        </div>

        <!-- 日志列表 -->
        <div class="space-y-1.5 max-h-96 overflow-y-auto">
          <div v-if="loadingAppLogs" class="text-center py-4 text-xs text-gray-400">加载中...</div>
          <div v-else-if="appLogs.length === 0" class="text-center py-4 text-xs text-gray-400">暂无日志</div>
          <div
            v-for="log in appLogs"
            :key="log.id"
            class="flex items-start gap-2 py-1.5 border-b border-gray-50 text-xs"
          >
            <span
              class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 mt-0.5"
              :class="{
                'bg-blue-50 text-blue-600': log.level === 'info',
                'bg-yellow-50 text-yellow-600': log.level === 'warn',
                'bg-red-50 text-red-600': log.level === 'error',
              }"
            >{{ log.level.toUpperCase() }}</span>
            <span class="text-gray-400 shrink-0">[{{ log.module }}]</span>
            <span class="text-gray-700 flex-1 break-all">{{ log.message }}</span>
            <span class="text-[10px] text-gray-300 shrink-0">{{ formatLocalTime(log.created_at) }}</span>
          </div>
        </div>

        <!-- 分页 -->
        <div v-if="appLogsPagination.total > 50" class="flex items-center justify-between mt-3 pt-2 border-t border-gray-100">
          <span class="text-[10px] text-gray-400">共 {{ appLogsPagination.total }} 条</span>
          <div class="flex gap-1">
            <button :disabled="appLogsPagination.page <= 1" @click="fetchAppLogs(appLogsPagination.page - 1)" class="px-2 py-1 text-xs border rounded disabled:opacity-30">‹</button>
            <span class="px-2 py-1 text-xs text-gray-500">{{ appLogsPagination.page }}</span>
            <button @click="fetchAppLogs(appLogsPagination.page + 1)" class="px-2 py-1 text-xs border rounded">›</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 6: 通知规则 -->
    <div v-if="activeTab === 'rules'" class="space-y-3">
      <!-- 新建版本 -->
      <div class="bg-white rounded-xl border border-gray-100 p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">新建版本</h3>
        <div class="space-y-3">
          <div>
            <label class="text-xs font-medium text-gray-600 mb-1 block">版本号</label>
            <input
              v-model="newRuleVersion"
              type="number"
              min="1"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="例如: 2"
            />
          </div>
          <div>
            <label class="text-xs font-medium text-gray-600 mb-1 block">规则内容 (JSON)</label>
            <textarea
              v-model="newRuleContent"
              rows="6"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none resize-y"
              placeholder='{ "nls": [...], "source_mapping": {...}, "processor": {...} }'
            ></textarea>
          </div>
          <button
            @click="createRule"
            :disabled="savingRule || !newRuleVersion || !newRuleContent"
            class="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {{ savingRule ? '保存中...' : '💾 保存规则' }}
          </button>
        </div>
      </div>

      <!-- 历史版本列表 -->
      <div class="bg-white rounded-xl border border-gray-100 p-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">通知记账规则版本</h3>
        <div v-if="loadingRules" class="text-center py-4 text-xs text-gray-400">加载中...</div>
        <div v-else-if="notifRules.length === 0" class="text-center py-4 text-xs text-gray-400">暂无规则版本</div>
        <div v-else class="space-y-2">
          <div v-for="rule in notifRules" :key="rule.id">
            <div
              class="flex items-center justify-between p-3 rounded-lg border"
              :class="rule.is_active ? 'border-green-200 bg-green-50' : 'border-gray-100'"
            >
              <div>
                <div class="text-sm font-medium text-gray-800">
                  版本 {{ rule.version }}
                  <span v-if="rule.is_active" class="ml-2 text-[10px] bg-green-500 text-white px-1.5 py-0.5 rounded-full">当前激活</span>
                </div>
                <div class="text-[10px] text-gray-400 mt-0.5">{{ formatLocalTime(rule.created_at) }}</div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  @click="togglePreview(rule.id)"
                  class="text-xs px-3 py-1 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                >{{ previewRuleId === rule.id ? '收起' : '预览' }}</button>
                <button
                  v-if="!rule.is_active"
                  @click="activateRule(rule.id)"
                  class="text-xs px-3 py-1 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100"
                >激活</button>
              </div>
            </div>
            <!-- Preview block -->
            <div v-if="previewRuleId === rule.id" class="mt-2">
              <pre class="overflow-auto max-h-60 text-xs font-mono bg-gray-50 p-3 rounded-lg border border-gray-100">{{ formatRuleJson(rule) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 用户账单明细弹窗 -->
    <div
      v-if="viewingUserId"
      class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center"
      @click.self="closeUserTransactions"
    >
      <div class="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h3 class="text-base font-semibold text-gray-800">用户账单明细</h3>
          <button @click="closeUserTransactions" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400">✕</button>
        </div>
        <div class="overflow-y-auto flex-1 px-5 py-4">
          <div v-if="userTransactionsLoading" class="text-center py-8 text-sm text-gray-400">加载中...</div>
          <div v-else-if="userTransactions.length === 0" class="text-center py-8 text-sm text-gray-400">暂无交易记录</div>
          <div v-else class="space-y-2">
            <div
              v-for="tx in userTransactions"
              :key="tx.id"
              class="flex items-center gap-3 p-2 rounded-lg bg-gray-50"
            >
              <span class="text-lg">{{ tx.category_icon || '📦' }}</span>
              <div class="flex-1 min-w-0">
                <div class="text-sm text-gray-800 truncate">{{ tx.description || '-' }}</div>
                <div class="text-[10px] text-gray-400">{{ tx.date }} · {{ tx.category_name || '-' }} · {{ tx.account_name || '-' }}</div>
              </div>
              <span v-if="tx.source" class="hidden md:inline text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">{{ tx.source }}</span>
              <span v-if="tx.date && tx.date.length > 10" class="hidden md:inline text-[10px] text-gray-300">{{ tx.date.slice(11, 16) }}</span>
              <span class="text-sm font-medium" :class="tx.type === 'expense' ? 'text-red-500' : 'text-green-500'">
                {{ tx.type === 'expense' ? '-' : '+' }}¥{{ formatAmount(tx.amount) }}
              </span>
            </div>
          </div>
          <!-- 分页 -->
          <div v-if="userTxTotal > 20" class="flex items-center justify-center gap-2 mt-4">
            <button :disabled="userTxPage <= 1" @click="fetchUserTransactions(viewingUserId!, userTxPage - 1)" class="px-3 py-1 text-xs border rounded disabled:opacity-30">上一页</button>
            <span class="text-xs text-gray-500">{{ userTxPage }} / {{ Math.ceil(userTxTotal / 20) }}</span>
            <button :disabled="userTxPage >= Math.ceil(userTxTotal / 20)" @click="fetchUserTransactions(viewingUserId!, userTxPage + 1)" class="px-3 py-1 text-xs border rounded disabled:opacity-30">下一页</button>
          </div>
        </div>
      </div>
    </div>
      </div><!-- content area end -->
    </div><!-- flex layout end -->
  </div>
</template>
