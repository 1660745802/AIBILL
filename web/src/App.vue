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
  { path: '/settings', label: '我的', icon: '⚙️' },
]
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

    <RouterView />

    <!-- 底部导航（仅登录后显示） -->
    <nav
      v-if="auth.isAuthenticated && !route.meta.guest"
      class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-2 flex justify-around items-center z-50"
    >
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="flex flex-col items-center py-1 px-3 rounded-lg transition-colors"
        :class="(item.path === '/' ? route.path === '/' : route.path.startsWith(item.path)) ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'"
      >
        <span class="text-lg">{{ item.icon }}</span>
        <span class="text-xs mt-0.5">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!-- 底部导航占位 -->
    <div v-if="auth.isAuthenticated && !route.meta.guest" class="h-16"></div>
  </div>
</template>
