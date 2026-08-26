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
})

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
  <div class="pb-20 md:pb-4">
    <!-- 用户信息 -->
    <div class="bg-white rounded-xl shadow-sm px-5 py-4 mb-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-full bg-blue-100 flex items-center justify-center text-lg font-medium text-blue-600">
            {{ (auth.user?.nickname || auth.user?.username || 'U').charAt(0).toUpperCase() }}
          </div>
          <div>
            <div class="text-base font-semibold text-[color:var(--color-text-primary)]">
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
          <span class="text-sm font-semibold text-[color:var(--color-text-primary)]">修改密码</span>
        </div>
        <span class="text-xs text-gray-400">{{ showPasswordForm ? '▲' : '▼' }}</span>
      </button>
      <form v-if="showPasswordForm" @submit.prevent="handleChangePassword" class="mt-3 space-y-2">
        <input
          v-model="oldPassword"
          type="password"
          class="w-full px-3 py-2 border border-[color:var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="当前密码"
        />
        <input
          v-model="newPassword"
          type="password"
          class="w-full px-3 py-2 border border-[color:var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="新密码（至少6位）"
        />
        <input
          v-model="confirmNewPassword"
          type="password"
          class="w-full px-3 py-2 border border-[color:var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          placeholder="确认新密码"
        />
        <div v-if="passwordError" class="text-xs text-red-500">{{ passwordError }}</div>
        <button
          type="submit"
          :disabled="passwordLoading"
          class="w-full py-2 btn-primary disabled:opacity-50"
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
          <span class="text-sm font-semibold text-[color:var(--color-text-primary)]">AI 记忆</span>
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
            class="flex-1 px-3 py-1.5 border border-[color:var(--color-border)] rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
      <h3 class="text-sm font-semibold text-[color:var(--color-text-primary)] mb-3 flex items-center gap-2">
        <span class="text-lg">📂</span> 数据管理
      </h3>
      <div class="space-y-2">
        <button
          @click="exportJson"
          class="w-full py-2 text-sm text-gray-700 border border-[color:var(--color-border)] rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📦 导出 JSON（全量备份）
        </button>
        <button
          @click="exportCsv"
          class="w-full py-2 text-sm text-gray-700 border border-[color:var(--color-border)] rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📄 导出 CSV（流水）
        </button>
        <button
          @click="router.push('/import')"
          class="w-full py-2 text-sm text-gray-700 border border-[color:var(--color-border)] rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          📥 导入账单
        </button>
        <button
          @click="router.push('/trash')"
          class="w-full py-2 text-sm text-gray-700 border border-[color:var(--color-border)] rounded-lg hover:bg-gray-50 text-left px-3 transition-colors"
        >
          🗑️ 回收站
        </button>
      </div>
    </div>
  </div>
</template>
