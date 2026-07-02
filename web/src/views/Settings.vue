<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import api from '@/api/index'
import CategoryManager from '@/components/CategoryManager.vue'
import AccountManager from '@/components/AccountManager.vue'

const router = useRouter()
const auth = useAuthStore()

// 管理员数据
const inviteCodes = ref<any[]>([])
const users = ref<any[]>([])
const globalSettings = ref<Record<string, string>>({})
const showAdmin = ref(false)

// 邀请码生成
const newCodeMaxUses = ref(1)
const generating = ref(false)

onMounted(async () => {
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
  } catch { /* ignore */ }
}

async function generateCode() {
  generating.value = true
  try {
    const { data } = await api.post('/admin/invite-codes', { max_uses: newCodeMaxUses.value })
    if (data.code === 0) {
      inviteCodes.value.unshift(data.data)
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

async function saveSettings() {
  try {
    await api.put('/admin/settings', globalSettings.value)
    alert('设置已保存')
  } catch { /* ignore */ }
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}

function exportJson() {
  window.open('/api/export/json')
}

function exportCsv() {
  window.open('/api/export/csv')
}
</script>

<template>
  <div class="pb-4">
    <!-- 用户信息 -->
    <div class="bg-white px-4 py-4 mb-2">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-base font-medium text-gray-800">
            {{ auth.user?.nickname || auth.user?.username }}
          </div>
          <div class="text-xs text-gray-400">
            @{{ auth.user?.username }}
            <span v-if="auth.isAdmin" class="ml-1 text-blue-500">管理员</span>
          </div>
        </div>
        <button
          @click="handleLogout"
          class="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded-md hover:bg-red-50"
        >
          退出登录
        </button>
      </div>
    </div>

    <!-- 分类/账户管理 -->
    <CategoryManager />
    <AccountManager />

    <!-- 数据管理 -->
    <div class="bg-white px-4 py-4 mb-2">
      <h3 class="text-sm font-medium text-gray-700 mb-3">📂 数据管理</h3>
      <div class="space-y-2">
        <button
          @click="exportJson"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3"
        >
          📦 导出 JSON（全量备份）
        </button>
        <button
          @click="exportCsv"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3"
        >
          📄 导出 CSV（流水）
        </button>
        <button
          @click="router.push('/import')"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3"
        >
          📥 导入账单
        </button>
        <button
          @click="router.push('/trash')"
          class="w-full py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 text-left px-3"
        >
          🗑️ 回收站
        </button>
      </div>
    </div>

    <!-- 管理员面板入口 -->
    <div v-if="auth.isAdmin" class="bg-white px-4 py-3 mb-2">
      <button
        @click="showAdmin = !showAdmin"
        class="w-full text-left text-sm font-medium text-gray-700 flex items-center justify-between"
      >
        <span>⚙️ 管理员面板</span>
        <span class="text-gray-400">{{ showAdmin ? '▲' : '▼' }}</span>
      </button>
    </div>

    <!-- 管理员面板内容 -->
    <div v-if="auth.isAdmin && showAdmin" class="space-y-2">
      <!-- 邀请码管理 -->
      <div class="bg-white px-4 py-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">邀请码管理</h3>
        <div class="flex gap-2 mb-3">
          <input
            v-model.number="newCodeMaxUses"
            type="number"
            min="1"
            max="100"
            class="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
          />
          <span class="self-center text-xs text-gray-500">次可用</span>
          <button
            @click="generateCode"
            :disabled="generating"
            class="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            生成邀请码
          </button>
        </div>
        <div class="space-y-1 max-h-40 overflow-y-auto">
          <div
            v-for="code in inviteCodes"
            :key="code.id"
            class="flex items-center justify-between py-1.5 text-xs border-b border-gray-50"
          >
            <div>
              <span class="font-mono font-medium text-gray-800">{{ code.code }}</span>
              <span class="ml-2 text-gray-400">{{ code.used_count }}/{{ code.max_uses }}</span>
            </div>
            <button
              v-if="code.used_count < code.max_uses"
              @click="revokeCode(code.id)"
              class="text-red-400 hover:text-red-600"
            >
              作废
            </button>
            <span v-else class="text-gray-300">已用完</span>
          </div>
        </div>
      </div>

      <!-- 用户管理 -->
      <div class="bg-white px-4 py-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">用户管理</h3>
        <div class="space-y-2">
          <div
            v-for="u in users"
            :key="u.id"
            class="flex items-center justify-between text-sm"
          >
            <div>
              <span class="text-gray-800">{{ u.nickname || u.username }}</span>
              <span class="text-xs text-gray-400 ml-1">{{ u.transaction_count }}笔</span>
              <span v-if="u.role === 'admin'" class="text-xs text-blue-500 ml-1">管理员</span>
            </div>
            <button
              v-if="u.id !== auth.user?.id"
              @click="toggleUser(u.id, u.is_active)"
              class="text-xs px-2 py-0.5 rounded"
              :class="u.is_active ? 'text-red-500 border border-red-200' : 'text-green-500 border border-green-200'"
            >
              {{ u.is_active ? '禁用' : '启用' }}
            </button>
          </div>
        </div>
      </div>

      <!-- AI 设置 -->
      <div class="bg-white px-4 py-4">
        <h3 class="text-sm font-medium text-gray-700 mb-3">AI 设置</h3>
        <div class="space-y-2">
          <div>
            <label class="text-xs text-gray-500">API Base URL</label>
            <input
              v-model="globalSettings.ai_base_url"
              type="text"
              class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm mt-0.5"
            />
          </div>
          <div>
            <label class="text-xs text-gray-500">API Key</label>
            <input
              v-model="globalSettings.ai_api_key"
              type="password"
              class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm mt-0.5"
              placeholder="sk-..."
            />
          </div>
          <div>
            <label class="text-xs text-gray-500">模型</label>
            <input
              v-model="globalSettings.ai_model"
              type="text"
              class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm mt-0.5"
            />
          </div>
          <button
            @click="saveSettings"
            class="w-full py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
