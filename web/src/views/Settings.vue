<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import api from '@/api/index'
import CategoryManager from '@/components/CategoryManager.vue'
import AccountManager from '@/components/AccountManager.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import Notice from '@/components/ui/Notice.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToast()
const confirm = useConfirm()

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
      // 改密会 bump token_version 使旧 token 失效，服务端已换发新 token。
      // 必须立即写入 localStorage，否则下一次请求 401 → 被静默踢回登录页。
      if (data.data?.token) {
        auth.setAuth(data.data.token, auth.user!)
      }
      toast.success('密码修改成功，其他设备需重新登录')
    } else {
      passwordError.value = data.message
    }
  } catch (e: any) {
    passwordError.value = e.response?.data?.message || '修改失败'
  } finally {
    passwordLoading.value = false
  }
}

// 数据管理
const showData = ref(false)

async function handleLogout() {
  const ok = await confirm({
    title: '退出登录',
    body: '退出后需要重新输入用户名和密码才能回到你的账本。',
  })
  if (!ok) return
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

const initial = computed(() =>
  (auth.user?.nickname || auth.user?.username || 'U').charAt(0).toUpperCase(),
)
</script>

<template>
  <div class="pb-24 md:pb-6">
    <PageHeader title="设置" subtitle="账户与数据" />

    <!-- 用户块 -->
    <div class="surface p-4 flex items-center gap-3 mb-6">
      <div class="avatar">{{ initial }}</div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-ink-1 truncate">
          {{ auth.user?.nickname || auth.user?.username }}
        </div>
        <div class="text-[11px] text-ink-3 truncate">@{{ auth.user?.username }}</div>
      </div>
      <span v-if="auth.isAdmin" class="badge badge-ink">管理员</span>
    </div>

    <div class="space-y-3">
      <!-- 折叠区：修改密码 -->
      <div class="surface surface-flush">
        <button
          type="button"
          class="fold-head"
          :aria-expanded="showPasswordForm"
          @click="showPasswordForm = !showPasswordForm"
        >
          <span class="tx-icon text-ink-2"><AppIcon name="lock" :size="16" /></span>
          <span class="flex-1 text-left text-sm font-semibold text-ink-1">修改密码</span>
          <AppIcon
            name="chevronDown"
            :size="16"
            class="chev-link transition-transform"
            :class="showPasswordForm ? 'rotate-180' : ''"
          />
        </button>
        <div v-if="showPasswordForm" class="fold-body">
          <form @submit.prevent="handleChangePassword" class="space-y-3">
            <div>
              <label class="field-label">当前密码</label>
              <input v-model="oldPassword" type="password" class="field" placeholder="当前密码" />
            </div>
            <div>
              <label class="field-label">新密码</label>
              <input v-model="newPassword" type="password" class="field" placeholder="至少 6 位" />
            </div>
            <div>
              <label class="field-label">确认新密码</label>
              <input v-model="confirmNewPassword" type="password" class="field" placeholder="再次输入新密码" />
            </div>
            <Notice v-if="passwordError" tone="danger">{{ passwordError }}</Notice>
            <button type="submit" :disabled="passwordLoading" class="btn btn-primary btn-block">
              {{ passwordLoading ? '提交中…' : '确认修改' }}
            </button>
          </form>
        </div>
      </div>

      <!-- 折叠区：数据管理 -->
      <div class="surface surface-flush">
        <button
          type="button"
          class="fold-head"
          :aria-expanded="showData"
          @click="showData = !showData"
        >
          <span class="tx-icon text-ink-2"><AppIcon name="folder" :size="16" /></span>
          <span class="flex-1 text-left text-sm font-semibold text-ink-1">数据管理</span>
          <AppIcon
            name="chevronDown"
            :size="16"
            class="chev-link transition-transform"
            :class="showData ? 'rotate-180' : ''"
          />
        </button>
        <div v-if="showData" class="fold-body">
          <div class="sheet">
            <button type="button" class="sheet-row sheet-row-click" @click="exportJson">
              <span class="tx-icon text-ink-2"><AppIcon name="download" :size="16" /></span>
              <div class="flex-1 min-w-0 text-left">
                <p class="text-sm text-ink-1">导出 JSON</p>
                <p class="text-[11px] text-ink-3">全量备份，含所有账户、交易与设置。</p>
              </div>
            </button>
            <button type="button" class="sheet-row sheet-row-click" @click="exportCsv">
              <span class="tx-icon text-ink-2"><AppIcon name="file" :size="16" /></span>
              <div class="flex-1 min-w-0 text-left">
                <p class="text-sm text-ink-1">导出 CSV</p>
                <p class="text-[11px] text-ink-3">仅流水，可用 Excel 打开核对。</p>
              </div>
            </button>
            <button type="button" class="sheet-row sheet-row-click" @click="router.push('/import')">
              <span class="tx-icon text-ink-2"><AppIcon name="upload" :size="16" /></span>
              <div class="flex-1 min-w-0 text-left">
                <p class="text-sm text-ink-1">导入账单</p>
                <p class="text-[11px] text-ink-3">从微信或支付宝的 CSV 账单一键导入。</p>
              </div>
              <AppIcon name="chevronRight" :size="16" class="chev-link" />
            </button>
            <button type="button" class="sheet-row sheet-row-click" @click="router.push('/trash')">
              <span class="tx-icon text-ink-2"><AppIcon name="trash" :size="16" /></span>
              <div class="flex-1 min-w-0 text-left">
                <p class="text-sm text-ink-1">回收站</p>
                <p class="text-[11px] text-ink-3">恢复误删的记录，30 天后自动清除。</p>
              </div>
              <AppIcon name="chevronRight" :size="16" class="chev-link" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分类 / 账户管理：组件自带 sheet 容器与标题，直接用 -->
    <div class="mt-6 space-y-6">
      <CategoryManager />
      <AccountManager />
    </div>

    <!-- 退出登录：与列表区留 24px 间距 -->
    <button class="btn btn-danger btn-block mt-6" @click="handleLogout">
      <AppIcon name="logout" :size="16" />
      退出登录
    </button>
  </div>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--color-action);
  color: var(--color-action-fg);
  font-size: 1.0625rem;
  font-weight: 600;
}

/* 折叠标题：整行可点，右侧 chevron 旋转 */
.fold-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.875rem 1rem;
  text-align: left;
  transition: background-color 0.12s ease;
}
.fold-head:hover { background: var(--color-paper-hover); }
.fold-body {
  padding: 0 1rem 1rem;
  border-top: 1px solid var(--color-rule-faint);
  padding-top: 1rem;
}
</style>
