<script setup lang="ts">
/**
 * 用户与邀请码 tab —— 访问管理。
 *
 * module 自持：用户列表、邀请码、行内用户明细（统计 + 重置密码 + 删除）、用户账单弹窗，
 * 以及读失败态。原先这些和 AI 设置、解析质量挤在同一个 script 里，靠「谁先 fetch」共享 ref；
 * 现在每个 panel 各取所需。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import { formatLocalTime } from '@/utils/date'
import AppIcon from '@/components/ui/AppIcon.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Money from '@/components/ui/Money.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'

const auth = useAuthStore()
const toast = useToast()
const confirm = useConfirm()

const users = ref<any[]>([])
const inviteCodes = ref<any[]>([])
const newCodeMaxUses = ref(1)
const generating = ref(false)
const copiedCodeId = ref<number | null>(null)

const showUserDetail = ref<any>(null)
const userStats = ref<any>(null)
const resetPasswordId = ref<number | null>(null)
const newPasswordInput = ref('')

const userTransactions = ref<any[]>([])
const userTransactionsLoading = ref(false)
const viewingUserId = ref<number | null>(null)
const userTxPage = ref(1)
const userTxTotal = ref(0)

const error = ref(false)

onMounted(fetchAdminData)

async function fetchAdminData() {
  try {
    const [codesRes, usersRes] = await Promise.all([
      api.get('/admin/invite-codes'),
      api.get('/admin/users'),
    ])
    if (codesRes.data.code === 0) inviteCodes.value = codesRes.data.data.items
    if (usersRes.data.code === 0) users.value = usersRes.data.data.items
    error.value = false
  } catch {
    error.value = true
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
  <AdminErrorBanner :show="error" @retry="fetchAdminData" />

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
</template>
