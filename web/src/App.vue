<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()

onMounted(async () => {
  if (auth.token && !auth.user) {
    await auth.fetchUser()
  }
})

const navItems = [
  { path: '/', label: '首页', icon: '🏠' },
  { path: '/transactions', label: '流水', icon: '📋' },
  { path: '/stats', label: '统计', icon: '📊' },
  { path: '/settings', label: '我的', icon: '⚙️' },
]
</script>

<template>
  <div class="min-h-screen bg-gray-50">
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
