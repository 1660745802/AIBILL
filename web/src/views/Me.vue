<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { useConfirm } from '@/composables/useConfirm'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const auth = useAuthStore()
const router = useRouter()
const confirm = useConfirm()

interface NavItem {
  path: string
  label: string
  icon: string
  desc: string
}

const sections = computed<{ title: string; items: NavItem[] }[]>(() => {
  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: '财务管理',
      items: [
        { path: '/assets', label: '资产全景', icon: 'wallet', desc: '各账户余额与净资产' },
      ],
    },
    {
      title: '工具',
      items: [
        { path: '/ai', label: 'AI 助手', icon: 'spark', desc: '智能问答与分析' },
        { path: '/import', label: '导入数据', icon: 'upload', desc: '微信/支付宝账单' },
        { path: '/trash', label: '回收站', icon: 'trash', desc: '已删除的记录' },
      ],
    },
    {
      title: '系统',
      items: [
        { path: '/settings', label: '设置', icon: 'settings', desc: '账户与偏好设置' },
        // 「管理面板」仅 admin 可见；非 admin 时系统分组仍有「设置」，不会留空分组
        ...(auth.isAdmin
          ? [{ path: '/admin', label: '管理面板', icon: 'shield', desc: '用户与系统管理' }]
          : []),
      ],
    },
  ]
  return groups
})

const initial = computed(() =>
  (auth.user?.nickname || auth.user?.username || '?')[0]?.toUpperCase(),
)

async function handleLogout() {
  const ok = await confirm({
    title: '退出登录',
    body: '退出后需要重新输入用户名和密码才能回到你的账本。',
  })
  if (!ok) return
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="pb-24 md:pb-6">
    <PageHeader title="我的" subtitle="账户、工具与系统设置" />

    <!-- 用户块 -->
    <div class="surface p-4 flex items-center gap-3 mb-6">
      <div class="avatar">{{ initial }}</div>
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold text-ink-1 truncate">
          {{ auth.user?.nickname || auth.user?.username }}
        </h2>
        <p class="text-[11px] text-ink-3 truncate">@{{ auth.user?.username }}</p>
      </div>
      <span v-if="auth.isAdmin" class="badge badge-ink">管理员</span>
    </div>

    <!-- 分组列表 -->
    <div class="space-y-6">
      <section v-for="section in sections" :key="section.title">
        <LedgerLabel>{{ section.title }}</LedgerLabel>
        <div class="sheet">
          <SheetRow
            v-for="item in section.items"
            :key="item.path"
            clickable
            @click="router.push(item.path)"
          >
            <span class="tx-icon text-ink-2"><AppIcon :name="item.icon" :size="16" /></span>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink-1 truncate">{{ item.label }}</p>
              <p class="text-[11px] text-ink-3 truncate">{{ item.desc }}</p>
            </div>
            <AppIcon name="chevronRight" :size="16" class="chev-link" />
          </SheetRow>
        </div>
      </section>
    </div>

    <!-- 退出登录：与列表行留 24px 间距 -->
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
</style>
