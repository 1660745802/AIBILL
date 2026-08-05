<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import api from '@/api/index'
import CategoryManager from '@/components/CategoryManager.vue'
import AccountManager from '@/components/AccountManager.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToast()

// 管理员数据
const inviteCodes = ref<any[]>([])
const users = ref<any[]>([])
const globalSettings = ref<Record<string, string>>({})
const showAdmin = ref(false)

// AI 解析质量数据
const parseStats = ref<any>(null)
const parseLogs = ref<any[]>([])
const parseLogsPagination = ref({ page: 1, page_size: 20, total: 0, total_pages: 0 })
const parseLogsFilter = ref({ status: '', days: '30' })
const showParseDetail = ref<any>(null)
const loadingParseLogs = ref(false)

// 邀请码生成
const newCodeMaxUses = ref(1)
const generating = ref(false)

// AI 记忆
interface Memory {
  id: string
  content: string
  category: string
  source: string
  is_active: number
  created_at: string
}
const showMemories = ref(false)
const memories = ref<Memory[]>([])
const newMemory = ref('')
const memoriesCount = computed(() => memories.value.length)

async function fetchMemories() {
  try {
    const { data } = await api.get('/memories')
    if (data.code === 0) memories.value = data.data.items
  } catch { /* ignore */ }
}

async function addMemory() {
  if (!newMemory.value.trim()) return
  try {
    const { data } = await api.post('/memories', {
      content: newMemory.value.trim(),
      category: 'preference',
    })
    if (data.code === 0) {
      memories.value.unshift(data.data)
      newMemory.value = ''
      toast.success('记忆已添加')
    }
  } catch { /* ignore */ }
}

async function toggleMemory(m: Memory) {
  const newVal = m.is_active ? 0 : 1
  try {
    const { data } = await api.put(`/memories/${m.id}`, { is_active: newVal })
    if (data.code === 0) m.is_active = newVal
  } catch { /* ignore */ }
}

async function deleteMemory(id: string) {
  try {
    const { data } = await api.delete(`/memories/${id}`)
    if (data.code === 0) {
      memories.value = memories.value.filter((m) => m.id !== id)
      toast.success('已删除')
    }
  } catch { /* ignore */ }
}

// 修改密码
const showPasswordForm = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const passwordError = ref('')
const passwordLoading = ref(false)

async function handleChangePassword() {
  passwordError.value = ''
  if (!oldPassword.value || !newPassword.value) {
    passwordError.value = '请填写所有字段'
    return
  }
  if (newPassword.value.length < 6) {
    passwordError.value = '新密码至少6个字符'
    return
  }
  if (newPassword.value !== confirmNewPassword.value) {
    passwordError.value = '两次密码不一致'
    return
  }
  passwordLoading.value = true
  try {
    const { data } = await api.put('/auth/password', {
      old_password: oldPassword.value,
      new_password: newPassword.value,
    })
    if (data.code === 0) {
      showPasswordForm.value = false
      oldPassword.value = ''
      newPassword.value = ''
      confirmNewPassword.value = ''
      toast.success('密码修改成功')
    } else {
      passwordError.value = data.message
    }
  } catch (e: any) {
    passwordError.value = e.response?.data?.message || '修改失败'
  } finally {
    passwordLoading.value = false
  }
}

onMounted(async () => {
  fetchMemories()
  if (auth.isAdmin) {
    await fetchAdminData()
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

// 用户详情/操作
const showUserDetail = ref<any>(null)
const userStats = ref<any>(null)
const resetPasswordId = ref<number | null>(null)
const newPasswordInput = ref('')

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
  // SQLite datetime('now') 存的是 UTC，加 Z 后缀转为本地时间
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

function handleLogout() {
  auth.logout()
  router.push('/login')
}

function exportJson() {
  api.get('/export/json', { responseType: 'blob' }).then((res) => {
    const url = URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `export_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }).catch(() => toast.error('导出失败'))
}

function exportCsv() {
  api.get('/export/csv', { responseType: 'blob' }).then((res) => {
    const url = URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `transactions_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }).catch(() => toast.error('导出失败'))
}
</script>


<template>
  <div class="pb-4">
    <!-- 用户信息 -->
    <div class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-full bg-blue-100 flex items-center justify-center text-lg font-medium text-blue-600">
            {{ (auth.user?.nickname || auth.user?.username || 'U').charAt(0).toUpperCase() }}
          </div>
          <div>
            <div class="text-base font-semibold text-gray-800">
              {{ auth.user?.nickname || auth.user?.username }}
            </div>
            <div class="text-xs text-gray-400">
              @{{ auth.user?.username }}
              <span v-if="auth.isAdmin" class="ml-1 text-blue-500">管理员</span>
            </div>
          </div>
        </div>
        <button
          @click="handleLogout"
          class="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
        >
          退出登录
        </button>
      </div>
    </div>

    <!-- 修改密码 -->
    <div class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <button
        @click="showPasswordForm = !showPasswordForm"
        class="w-full text-left flex items-center justify-between"
      >
        <div class="flex items-center gap-2">
          <span class="text-lg">🔒</span>
          <span class="text-sm font-semibold text-gray-800">修改密码</span>
        </div>
        <span class="text-xs text-gray-400">{{ showPasswordForm ? '▲' : '▼' }}</span>
      </button>
      <form v-if="showPasswordForm" @submit.prevent="handleChangePassword" class="mt-3 space-y-2">
        <input
          v-model="oldPassword"
          type="password"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="当前密码"
        />
        <input
          v-model="newPassword"
          type="password"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="新密码（至少6位）"
        />
        <input
          v-model="confirmNewPassword"
          type="password"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="确认新密码"
        />
        <div v-if="passwordError" class="text-xs text-red-500">{{ passwordError }}</div>
        <button
          type="submit"
          :disabled="passwordLoading"
          class="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {{ passwordLoading ? '提交中...' : '确认修改' }}
        </button>
      </form>
    </div>

    <!-- 分类/账户管理 -->
    <CategoryManager />
    <AccountManager />

    <!-- AI 记忆 -->
    <div class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <button @click="showMemories = !showMemories" class="w-full text-left flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-lg">💭</span>
          <span class="text-sm font-semibold text-gray-800">AI 记忆</span>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="memoriesCount > 0" class="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full">{{ memoriesCount }} 条</span>
          <span class="text-xs text-gray-400">{{ showMemories ? '▲' : '▼' }}</span>
        </div>
      </button>
      <div v-if="showMemories" class="mt-3 space-y-2">
        <div
          v-for="m in memories"
          :key="m.id"
          class="flex items-start justify-between p-2.5 bg-gray-50 rounded-lg"
        >
          <div class="flex-1 text-xs text-gray-700" :class="{ 'opacity-40 line-through': !m.is_active }">
            {{ m.content }}
          </div>
          <div class="flex gap-2 ml-2 shrink-0">
            <button @click="toggleMemory(m)" class="text-[10px] text-gray-400 hover:text-blue-500">
              {{ m.is_active ? '停用' : '启用' }}
            </button>
            <button @click="deleteMemory(m.id)" class="text-[10px] text-red-400 hover:text-red-600">删除</button>
          </div>
        </div>
        <div v-if="memories.length === 0" class="text-xs text-gray-400 text-center py-3">
          AI 还没有记住任何偏好
        </div>
        <div class="flex gap-2">
          <input
            v-model="newMemory"
            type="text"
            placeholder="手动添加记忆..."
            class="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <button
            @click="addMemory"
            :disabled="!newMemory.trim()"
            class="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-50"
          >
            添加
          </button>
        </div>
      </div>
    </div>

    <!-- 数据管理 -->
    <div class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <h3 class="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
        <span class="text-lg">📂</span> 数据管理
      </h3>
      <div class="space-y-2">
        <button
          @click="exportJson"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📦 导出 JSON（全量备份）
        </button>
        <button
          @click="exportCsv"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📄 导出 CSV（流水）
        </button>
        <button
          @click="router.push('/import')"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📥 导入账单
        </button>
        <button
          @click="router.push('/trash')"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          🗑️ 回收站
        </button>
      </div>
    </div>

    <!-- 管理员面板入口 -->
    <div v-if="auth.isAdmin" class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <button
        @click="showAdmin = !showAdmin"
        class="w-full text-left flex items-center justify-between"
      >
        <div class="flex items-center gap-2">
          <span class="text-lg">🛠️</span>
          <span class="text-sm font-semibold text-gray-800">管理员面板</span>
        </div>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">{{ showAdmin ? '收起 ▲' : '展开 ▼' }}</span>
      </button>
    </div>

    <!-- 管理员面板内容 -->
    <div v-if="auth.isAdmin && showAdmin" class="space-y-3 mb-3">

      <!-- 邀请码管理 -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <span class="text-lg">🎟️</span>
          <h3 class="text-sm font-semibold text-gray-800">邀请码管理</h3>
        </div>
        <div class="px-5 py-4">
          <div class="flex items-center gap-3 mb-4">
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
              class="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg"
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

      <!-- 用户管理 -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <span class="text-lg">👥</span>
          <h3 class="text-sm font-semibold text-gray-800">用户管理</h3>
          <span class="text-xs text-gray-400 ml-auto">{{ users.length }} 人</span>
        </div>
        <div class="px-5 py-3">
          <div class="space-y-1">
            <div
              v-for="u in users"
              :key="u.id"
              class="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div class="flex items-center gap-3 cursor-pointer flex-1" @click="viewUserDetail(u.id)">
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
              <div class="flex items-center gap-2">
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
              <div class="flex items-center gap-2">
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

      <!-- AI 模型配置 -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
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

      <!-- AI 解析质量监控 -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
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

        <div class="px-5 py-4">
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
  </div>
</template>
