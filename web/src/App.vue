<script setup lang="ts">
import { onMounted, computed, ref, watch } from 'vue'
import { RouterView, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppIcon from '@/components/ui/AppIcon.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import ConfirmHost from '@/components/ui/ConfirmHost.vue'

const auth = useAuthStore()
const route = useRoute()

onMounted(async () => {
  if (auth.token && !auth.user) await auth.fetchUser()
})

/* ── 导航结构 ──────────────────────────────────────────
   分组不按“功能类型”，而按真实使用频率排：
   记账 / 账本 / 本月 占 90%+ 的使用时长；预算、目标、订阅
   建过但从未被打开，已从 Web 端下线（后端接口保留给 App），
   如需回滚，旧路由已重定向到 /me。                            */

interface NavItem { path: string; label: string; icon: string }

const PRIMARY = computed<NavItem[]>(() => [
  { path: '/', label: '记一笔', icon: 'pen' },
  { path: '/ledger', label: '账本', icon: 'ledger' },
  { path: '/overview', label: '本月', icon: 'chart' },
  { path: '/ai', label: 'AI 助手', icon: 'spark' },
])

const SYSTEM = computed<NavItem[]>(() => [
  { path: '/assets', label: '资产全景', icon: 'wallet' },
  { path: '/import', label: '导入账单', icon: 'upload' },
  { path: '/settings', label: '设置', icon: 'settings' },
  ...(auth.isAdmin ? [{ path: '/admin', label: '管理面板', icon: 'shield' }] : []),
])

/** 「我的」聚合的二级页 */
const ME_CHILDREN = ['/me', '/settings', '/assets', '/import', '/trash', '/admin']

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/' || route.path === '/quick'
  if (path === '/me') return ME_CHILDREN.includes(route.path)
  return route.path === path || route.path.startsWith(path + '/')
}

const displayName = computed(() => auth.user?.nickname || auth.user?.username || '')
const initial = computed(() => displayName.value.charAt(0).toUpperCase() || '?')

/** 顶部条标题：优先路由 meta，其次从导航结构反查 */
const pageTitle = computed(() => {
  if (route.meta.title) return String(route.meta.title)
  const all = PRIMARY.value.concat(SYSTEM.value)
  return all.find(i => isActive(i.path))?.label ?? '财务工作台'
})

const today = new Date()
const todayLabel = computed(() =>
  `${today.getMonth() + 1}月${today.getDate()}日 周${'日一二三四五六'[today.getDay()]}`,
)

/** flush 路由（AI 助手）自己管理整屏高度，不加页面留白 */
const flush = computed(() => route.meta.flush === true)

const railOpen = ref(false)
watch(() => route.path, () => { railOpen.value = false })
</script>

<template>
  <div class="app-shell">
    <ToastHost />
    <ConfirmHost />

    <!-- 已登录 -->
    <div
      v-if="auth.isAuthenticated && !route.meta.guest"
      class="app-frame"
      :class="{ 'frame-flush': flush }"
    >
      <!-- 桌面 / 平板 侧栏 -->
      <aside class="rail" :class="{ 'rail-open': railOpen }">
        <div class="rail-brand">
          <RouterLink to="/" class="flex items-center gap-2.5 min-w-0">
            <span class="rail-mark" aria-hidden="true">账</span>
            <span class="rail-brand-text min-w-0">
              <span class="rail-brand-name">财务工作台</span>
              <span class="rail-brand-user">{{ displayName }}</span>
            </span>
          </RouterLink>
        </div>

        <nav class="rail-nav scroll-thin" aria-label="主导航">
          <p class="rail-group-title">每天</p>
          <RouterLink
            v-for="item in PRIMARY"
            :key="item.path"
            :to="item.path"
            class="rail-item"
            :class="{ 'rail-item-on': isActive(item.path) }"
            :title="item.label"
          >
            <AppIcon :name="item.icon" :size="17" />
            <span class="rail-label">{{ item.label }}</span>
          </RouterLink>

          <div v-if="SYSTEM.length" class="rail-group">
            <p class="rail-group-title">偶尔</p>
            <RouterLink
              v-for="item in SYSTEM"
              :key="item.path"
              :to="item.path"
              class="rail-item"
              :class="{ 'rail-item-on': isActive(item.path) }"
              :title="item.label"
            >
              <AppIcon :name="item.icon" :size="17" />
              <span class="rail-label">{{ item.label }}</span>
            </RouterLink>
          </div>
        </nav>

        <RouterLink to="/me" class="rail-foot" :class="{ 'rail-item-on': isActive('/me') }">
          <span class="rail-avatar" aria-hidden="true">{{ initial }}</span>
          <span class="rail-label min-w-0">
            <span class="block text-xs font-semibold truncate" style="color: var(--color-ink-1)">{{ displayName }}</span>
            <span class="block text-[10px] truncate" style="color: var(--color-ink-3)">
              {{ auth.isAdmin ? '管理员' : '@' + auth.user?.username }}
            </span>
          </span>
        </RouterLink>
      </aside>

      <!-- 内容区 -->
      <div class="app-body">
        <!-- 手机吸顶条 -->
        <header class="topbar">
          <span class="rail-mark rail-mark-sm" aria-hidden="true">账</span>
          <div class="min-w-0 flex-1">
            <h1 class="topbar-title truncate">{{ pageTitle }}</h1>
            <p class="topbar-sub amt">{{ todayLabel }}</p>
          </div>
          <RouterLink to="/me" class="topbar-avatar" :aria-label="`${displayName} 的账户`">{{ initial }}</RouterLink>
        </header>

        <main class="app-content" :class="flush ? 'app-content-flush' : ''">
          <RouterView v-slot="{ Component, route: viewRoute }">
            <!-- 不用 mode="out-in"：该模式要求旧组件离场动画结束后新组件才进场，
                 快速连续切 tab 时离场会被下一次切换打断，导致新组件 enter 丢失、
                 <main> 停在空占位（<!---->）= 白屏。改为并发过渡：新组件立即挂载进场，
                 旧组件独立离场，任何一方被打断都不影响另一方，不会留空窗。 -->
            <Transition name="rise">
              <component :is="Component" :key="viewRoute.path" />
            </Transition>
          </RouterView>
        </main>
      </div>

      <!-- 手机底部导航 -->
      <nav class="tabbar safe-bottom" aria-label="底部导航">
        <RouterLink
          v-for="t in [
            { path: '/ledger', label: '账本', icon: 'ledger' },
            { path: '/overview', label: '本月', icon: 'chart' },
          ]"
          :key="t.path"
          :to="t.path"
          class="tab"
          :class="{ 'tab-on': isActive(t.path) }"
        >
          <AppIcon :name="t.icon" :size="20" :stroke="isActive(t.path) ? 2 : 1.6" />
          <span class="tab-label">{{ t.label }}</span>
        </RouterLink>

        <RouterLink to="/" class="tab-fab" aria-label="记一笔">
          <AppIcon name="plus" :size="22" :stroke="2.2" />
        </RouterLink>

        <RouterLink
          v-for="t in [
            { path: '/ai', label: '助手', icon: 'spark' },
            { path: '/me', label: '我的', icon: 'user' },
          ]"
          :key="t.path"
          :to="t.path"
          class="tab"
          :class="{ 'tab-on': isActive(t.path) }"
        >
          <AppIcon :name="t.icon" :size="20" :stroke="isActive(t.path) ? 2 : 1.6" />
          <span class="tab-label">{{ t.label }}</span>
        </RouterLink>
      </nav>
    </div>

    <!-- 未登录 / 访客页 -->
    <div v-else>
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.app-shell { min-height: 100dvh; background: var(--color-paper); }
.app-frame { display: flex; min-height: 100dvh; }

/* ── 侧栏 ─────────────────────────────────────── */
.rail {
  position: fixed;
  inset-block: 0;
  left: 0;
  z-index: 40;
  width: 232px;
  display: flex;
  flex-direction: column;
  background: var(--color-paper-raised);
  border-right: 1px solid var(--color-rule);
}
@media (max-width: 1023px) { .rail { display: none; } }

.rail-brand {
  padding: 1rem 1rem 0.875rem;
  border-bottom: 3px double var(--color-rule-strong);
}
.rail-mark {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  background: var(--color-action);
  color: var(--color-action-fg);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0;
}
.rail-mark-sm { width: 1.5rem; height: 1.5rem; font-size: 0.6875rem; }
.rail-brand-name {
  display: block;
  font-size: 0.8125rem;
  font-weight: 650;
  color: var(--color-ink-1);
  line-height: 1.2;
}
.rail-brand-user {
  display: block;
  font-size: 0.6875rem;
  color: var(--color-ink-3);
  line-height: 1.3;
}

.rail-nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem 0.625rem 1rem;
}
.rail-group + .rail-group {
  margin-top: 0.875rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-rule-faint);
}
.rail-group-title {
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--color-ink-4);
  padding: 0 0.5rem;
  margin-bottom: 0.3125rem;
}
.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.4375rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-ink-3);
  transition: background-color 0.13s ease, color 0.13s ease;
}
.rail-item:hover { background: var(--color-paper-hover); color: var(--color-ink-1); }
/* 选中 = 左侧墨条 + 墨色字，不用填充药丸 */
.rail-item-on { color: var(--color-ink-1); background: var(--color-paper-hover); }
.rail-item-on::before {
  content: '';
  position: absolute;
  left: -0.625rem;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 1.125rem;
  border-radius: 0 2px 2px 0;
  background: var(--color-action);
}
.rail-label { flex: 1; min-width: 0; }
.rail-tag {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--color-ink-4);
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  padding: 0 0.1875rem;
  line-height: 1.4;
}

.rail-foot {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 1rem;
  border-top: 1px solid var(--color-rule);
  color: var(--color-ink-3);
  transition: background-color 0.13s;
}
.rail-foot:hover { background: var(--color-paper-hover); }
.rail-avatar {
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

/* ── 内容 ─────────────────────────────────────── */
.app-body { flex: 1; min-width: 0; margin-left: 232px; }
@media (max-width: 1023px) { .app-body { margin-left: 0; } }

.app-content {
  position: relative; /* 作为路由过渡时离场组件 absolute 定位的参照 */
  max-width: 68rem;
  margin-inline: auto;
  padding: 1.5rem 1rem 6rem;
}
@media (min-width: 1024px) { .app-content { padding: 2rem 2rem 3rem; } }
.app-content-flush { padding: 0 0 4.5rem; max-width: none; }

/* ── 手机吸顶条 ─────────────────────────────────── */
.topbar { display: none; }
@media (max-width: 1023px) {
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    background: var(--color-paper);
    border-bottom: 3px double var(--color-rule-strong);
  }
}
/* flush 页面自带报头，不再叠加外壳吸顶条 */
.frame-flush .topbar { display: none !important; }
.topbar-title {
  font-size: 0.9375rem;
  font-weight: 650;
  color: var(--color-ink-1);
  line-height: 1.2;
}
.topbar-sub {
  font-size: 0.6875rem;
  color: var(--color-ink-3);
  line-height: 1.3;
}
.topbar-avatar {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  color: var(--color-ink-1);
  font-size: 0.75rem;
  font-weight: 650;
}

/* ── 底部 Tab ──────────────────────────────────── */
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: none;
  align-items: center;
  justify-content: space-around;
  padding: 0.375rem 0.5rem 0.375rem;
  background: color-mix(in srgb, var(--color-paper-raised) 92%, transparent);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--color-rule);
}
@media (max-width: 1023px) { .tabbar { display: flex; } }

.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  min-width: 3.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  color: var(--color-ink-4);
  transition: color 0.13s;
}
.tab-on { color: var(--color-ink-1); }
.tab-label { font-size: 0.625rem; font-weight: 500; line-height: 1.2; }

/* 中间凸起的记账按钮 */
.tab-fab {
  width: 2.75rem;
  height: 2.75rem;
  margin-top: -1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-action);
  color: var(--color-action-fg);
  border: 3px solid var(--color-paper);
  box-shadow: 0 4px 12px -2px color-mix(in srgb, var(--color-action) 45%, transparent);
  transition: transform 0.14s ease;
}
.tab-fab:active { transform: scale(0.94); }

/* 内容底部给导航让位 */
@media (max-width: 1023px) {
  .app-content { padding-bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px)); }
  .app-content-flush { padding-bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px)); }
}
</style>
