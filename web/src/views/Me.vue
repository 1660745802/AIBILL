<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { NAV_GROUPS } from '@/nav'
import { useInvestmentNav } from '@/composables/useInvestmentNav'
import { useRouter } from 'vue-router'
import { useConfirm } from '@/composables/useConfirm'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const auth = useAuthStore()
const { hasInvestment } = useInvestmentNav()
const router = useRouter()
const confirm = useConfirm()

/** 分组直接复用 @/nav.ts：与侧栏同源，不重写一份。
 *  上一版这里自己定义了一份 NavItem 并只收「不常用」的那几个入口，
 *  结果侧栏和这一页各列一遍功能——同一个功能两个入口，人会犹豫点哪个。 */
const sections = computed(() =>
  NAV_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    // 过滤规则必须和侧栏（App.vue）**完全一致**，否则同一项在两处结果相反，
    // 而这一页的副标题还写着「与侧栏一致」。
    items: g.items.filter(
      (i) => (!i.adminOnly || auth.isAdmin) && (!i.needsInvestment || hasInvestment.value),
    ),
  })).filter((g) => g.items.length > 0),
)

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
    <PageHeader title="全部功能" subtitle="按用途分组，与侧栏一致" />

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
      <section v-for="section in sections" :key="section.label">
        <LedgerLabel>{{ section.label }}</LedgerLabel>
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
