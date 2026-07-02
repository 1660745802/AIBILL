<script setup lang="ts">
import { onMounted } from 'vue'
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

const navItems = [
  { path: '/', label: '首页', icon: '🏠' },
  { path: '/transactions', label: '流水', icon: '📋' },
  { path: '/stats', label: '统计', icon: '📊' },
  { path: '/ai', label: 'AI', icon: '🤖' },
  { path: '/budget', label: '预算', icon: '💰' },
  { path: '/settings', label: '我的', icon: '⚙️' },
]

const mobileNavItems = [
  { path: '/', label: '首页', icon: '🏠' },
  { path: '/transactions', label: '流水', icon: '📋' },
  { path: '/stats', label: '统计', icon: '📊' },
  { path: '/budget', label: '预算', icon: '💰' },
  { path: '/settings', label: '我的', icon: '⚙️' },
]

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 全局 Toast -->
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
            class="pointer-events-auto px-4 py-3 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2 cursor-pointer"
            :class="{
              'bg-green-500 text-white': t.type === 'success',
              'bg-red-500 text-white': t.type === 'error',
              'bg-amber-500 text-white': t.type === 'warning',
              'bg-gray-800 text-white': t.type === 'info',
            }"
            @click="toast.dismiss(t.id)"
          >
            <span>{{ t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warning' ? '⚠' : 'ℹ' }}</span>
            <span>{{ t.message }}</span>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>

    <!-- 已登录：响应式布局 -->
    <div v-if="auth.isAuthenticated && !route.meta.guest" class="flex min-h-screen">
      <!-- PC 侧边栏（≥768px 显示） -->
      <aside class="hidden md:flex md:flex-col md:w-56 lg:w-64 bg-white border-r border-gray-200 fixed inset-y-0 left-0 z-40">
        <!-- Logo -->
        <div class="px-5 py-5 border-b border-gray-100">
          <h1 class="text-lg font-bold text-gray-800">💰 AI 记账</h1>
          <p class="text-xs text-gray-400 mt-0.5">{{ auth.user?.nickname || auth.user?.username }}</p>
        </div>

        <!-- 导航 -->
        <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <RouterLink
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
            :class="isActive(item.path)
              ? 'bg-blue-50 text-blue-700'
              : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'"
          >
            <span class="text-base">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>

        <!-- 底部 -->
        <div class="px-3 py-3 border-t border-gray-100">
          <div class="text-xs text-gray-400 px-3">v1.1.0</div>
        </div>
      </aside>

      <!-- 主内容区 -->
      <main class="flex-1 md:ml-56 lg:ml-64">
        <div class="max-w-3xl mx-auto">
          <RouterView v-slot="{ Component, route: viewRoute }">
            <component :is="Component" :key="viewRoute.path" />
          </RouterView>
        </div>
      </main>

      <!-- 移动端底部导航（<768px 显示） -->
      <nav class="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-2 py-1.5 flex justify-around items-center z-50">
        <RouterLink
          v-for="item in mobileNavItems"
          :key="item.path"
          :to="item.path"
          class="flex flex-col items-center py-1 px-2 rounded-lg transition-colors min-w-0"
          :class="isActive(item.path) ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'"
        >
          <span class="text-base">{{ item.icon }}</span>
          <span class="text-[10px] mt-0.5 truncate">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <!-- 移动端底部占位 -->
      <div class="md:hidden h-14"></div>
    </div>

    <!-- 未登录：居中布局（登录/注册页） -->
    <div v-else>
      <RouterView v-slot="{ Component, route: viewRoute }">
        <component :is="Component" :key="viewRoute.path" />
      </RouterView>
    </div>
  </div>
</template>
