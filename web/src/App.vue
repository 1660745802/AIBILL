<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { RouterView, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'

const auth = useAuthStore()
const route = useRoute()
const toast = useToast()

onMounted(async () => {
  if (auth.token && !auth.user) {
    await auth.fetchUser()
  }
})

// PC 侧边栏：分组展示全部功能
const sidebarGroups = computed(() => [
  {
    items: [
      { path: '/', label: '总览', icon: 'home' },
      { path: '/quick', label: '记账', icon: 'plus' },
      { path: '/ledger', label: '账本', icon: 'book' },
    ],
  },
  {
    items: [
      { path: '/assets', label: '资产', icon: 'wallet' },
      { path: '/goals', label: '目标', icon: 'target' },
      { path: '/budget', label: '预算', icon: 'chart' },
      { path: '/subscriptions', label: '订阅', icon: 'refresh' },
    ],
  },
  {
    items: [
      { path: '/ai', label: 'AI 助手', icon: 'sparkle' },
      { path: '/import', label: '导入', icon: 'download' },
      { path: '/settings', label: '设置', icon: 'gear' },
      ...(auth.isAdmin ? [{ path: '/admin', label: '管理', icon: 'shield' }] : []),
    ],
  },
])

// 移动端底部：4 个 Tab
const mobileNavItems = [
  { path: '/', label: '总览', icon: 'home' },
  { path: '/quick', label: '记账', icon: 'plus' },
  { path: '/ledger', label: '账本', icon: 'book' },
  { path: '/me', label: '我的', icon: 'user' },
]

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/'
  if (path === '/me') return route.path === '/me' || route.path === '/settings' || route.path === '/assets' || route.path === '/goals' || route.path === '/budget' || route.path === '/subscriptions' || route.path === '/import' || route.path === '/ai' || route.path === '/admin' || route.path === '/trash'
  return route.path === path || route.path.startsWith(path + '/')
}

// SVG 图标路径
const iconPaths: Record<string, string> = {
  home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  plus: 'M12 4v16m8-8H4',
  book: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  wallet: 'M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-5zm-5 0a1 1 0 100 2 1 1 0 000-2z',
  target: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  shield: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  chart: 'M3 13h2v8H3zm6-4h2v12H9zm6-6h2v18h-2zm6 10h2v8h-2z',
  refresh: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  sparkle: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z',
  download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
  gear: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'gear-inner': 'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
}
</script>

<template>
  <div class="min-h-screen" style="background-color: var(--color-page-bg)">
    <!-- Toast -->
    <Teleport to="body">
      <div class="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 w-[90%] max-w-sm pointer-events-none">
        <TransitionGroup
          enter-active-class="transition-all duration-300 ease-out"
          leave-active-class="transition-all duration-200 ease-in"
          enter-from-class="opacity-0 -translate-y-2 scale-95"
          enter-to-class="opacity-100 translate-y-0 scale-100"
          leave-from-class="opacity-100 translate-y-0 scale-100"
          leave-to-class="opacity-0 -translate-y-1 scale-95"
        >
          <div
            v-for="t in toast.toasts.value"
            :key="t.id"
            class="pointer-events-auto px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2 cursor-pointer backdrop-blur-sm"
            :class="{
              'bg-emerald-600/90 text-white': t.type === 'success',
              'bg-red-600/90 text-white': t.type === 'error',
              'bg-amber-500/90 text-white': t.type === 'warning',
              'bg-gray-800/90 text-white': t.type === 'info',
            }"
            @click="toast.dismiss(t.id)"
          >
            <span class="text-xs">{{ t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warning' ? '!' : 'i' }}</span>
            <span>{{ t.message }}</span>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>

    <!-- 已登录 -->
    <div v-if="auth.isAuthenticated && !route.meta.guest" class="flex min-h-screen">
      <!-- PC 侧边栏 -->
      <aside class="hidden md:flex md:flex-col md:w-52 lg:w-56 fixed inset-y-0 left-0 z-40"
             style="background-color: var(--color-sidebar-bg); border-right: 1px solid var(--color-border)">
        <!-- Brand -->
        <div class="px-4 py-4" style="border-bottom: 1px solid var(--color-border-light)">
          <div class="flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-xs" style="background: var(--color-primary-600)">F</div>
            <div>
              <h1 class="text-[13px] font-semibold" style="color: var(--color-text-primary)">财务工作台</h1>
              <p class="text-[10px]" style="color: var(--color-text-muted)">{{ auth.user?.nickname || auth.user?.username }}</p>
            </div>
          </div>
        </div>

        <!-- Nav Groups -->
        <nav class="flex-1 px-2.5 py-3 overflow-y-auto">
          <div v-for="(group, gi) in sidebarGroups" :key="gi" :class="gi > 0 ? 'mt-2 pt-2' : ''" :style="gi > 0 ? 'border-top: 1px solid var(--color-border-light)' : ''">
            <RouterLink
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              class="nav-item"
              :class="{ 'nav-item-active': isActive(item.path) }"
            >
              <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" :d="iconPaths[item.icon]" />
                <path v-if="iconPaths[item.icon + '-inner']" stroke-linecap="round" stroke-linejoin="round" :d="iconPaths[item.icon + '-inner']" />
              </svg>
              <span class="text-[13px]">{{ item.label }}</span>
            </RouterLink>
          </div>
        </nav>

        <!-- Footer -->
        <div class="px-4 py-2.5" style="border-top: 1px solid var(--color-border-light)">
          <span class="text-[10px]" style="color: var(--color-text-muted)">v2.0</span>
        </div>
      </aside>

      <!-- 主内容 -->
      <main class="flex-1 md:ml-52 lg:ml-56 min-h-screen pb-20 md:pb-0">
        <div class="max-w-5xl mx-auto px-4 lg:px-8 py-4 lg:py-6">
          <RouterView v-slot="{ Component, route: viewRoute }">
            <component :is="Component" :key="viewRoute.path" />
          </RouterView>
        </div>
      </main>

      <!-- 移动端底部 Tab (4个) -->
      <nav class="md:hidden fixed bottom-0 left-0 right-0 px-4 py-2 flex justify-around items-center z-50 safe-area-bottom backdrop-blur-xl"
           style="background: rgba(255,255,255,0.88); border-top: 1px solid var(--color-border-light)">
        <RouterLink
          v-for="item in mobileNavItems"
          :key="item.path"
          :to="item.path"
          class="flex flex-col items-center py-1.5 px-4 rounded-xl transition-all"
          :style="isActive(item.path) ? 'color: var(--color-primary-600)' : 'color: #9ca3af'"
        >
          <svg class="w-[22px] h-[22px]" fill="none" stroke="currentColor" :stroke-width="isActive(item.path) ? '2' : '1.5'" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" :d="iconPaths[item.icon]" />
          </svg>
          <span class="text-[10px] mt-0.5 font-medium">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </div>

    <!-- 未登录 -->
    <div v-else>
      <RouterView v-slot="{ Component, route: viewRoute }">
        <component :is="Component" :key="viewRoute.path" />
      </RouterView>
    </div>
  </div>
</template>
