<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'

const auth = useAuthStore()
const router = useRouter()

const sections = computed(() => [
  {
    title: '财务管理',
    items: [
      { path: '/assets', label: '资产全景', icon: '💰', desc: '净资产与账户管理' },
      { path: '/goals', label: '财务目标', icon: '🎯', desc: '储蓄和还贷追踪' },
      { path: '/budget', label: '预算管理', icon: '📊', desc: '月度预算与警报' },
      { path: '/subscriptions', label: '订阅管理', icon: '🔁', desc: '周期性支出追踪' },
    ],
  },
  {
    title: '工具',
    items: [
      { path: '/ai', label: 'AI 助手', icon: '🤖', desc: '智能问答与分析' },
      { path: '/import', label: '导入数据', icon: '📥', desc: '微信/支付宝账单' },
      { path: '/trash', label: '回收站', icon: '🗑️', desc: '已删除的记录' },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/settings', label: '设置', icon: '⚙️', desc: '账户与偏好设置' },
      ...(auth.isAdmin ? [{ path: '/admin', label: '管理面板', icon: '🛡️', desc: '用户与系统管理' }] : []),
    ],
  },
])

function handleLogout() {
  if (confirm('确定退出登录？')) {
    auth.logout()
    router.push('/login')
  }
}
</script>

<template>
  <div class="pb-20 md:pb-4">
    <!-- 用户信息 -->
    <div class="card mb-5 flex items-center gap-3">
      <div class="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold" style="background: var(--color-primary-500)">
        {{ (auth.user?.nickname || auth.user?.username || '?')[0]?.toUpperCase() }}
      </div>
      <div class="flex-1">
        <h2 class="text-sm font-semibold" style="color: var(--color-text-primary)">{{ auth.user?.nickname || auth.user?.username }}</h2>
        <p class="text-[11px]" style="color: var(--color-text-muted)">@{{ auth.user?.username }}</p>
      </div>
      <router-link to="/settings" class="text-xs" style="color: var(--color-primary-600)">设置 →</router-link>
    </div>

    <!-- 功能分组 -->
    <div class="space-y-4">
      <div v-for="section in sections" :key="section.title">
        <h3 class="text-[11px] font-medium uppercase tracking-wider px-1 mb-2" style="color: var(--color-text-muted)">{{ section.title }}</h3>
        <div class="card !p-0 overflow-hidden">
          <router-link
            v-for="(item, i) in section.items"
            :key="item.path"
            :to="item.path"
            class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50"
            :style="i > 0 ? 'border-top: 1px solid var(--color-border-light)' : ''"
          >
            <span class="text-lg w-7 text-center">{{ item.icon }}</span>
            <div class="flex-1">
              <p class="text-sm font-medium" style="color: var(--color-text-primary)">{{ item.label }}</p>
              <p class="text-[11px]" style="color: var(--color-text-muted)">{{ item.desc }}</p>
            </div>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="color: var(--color-text-muted)">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </router-link>
        </div>
      </div>
    </div>

    <!-- 退出 -->
    <button
      @click="handleLogout"
      class="w-full mt-6 py-2.5 text-sm font-medium rounded-xl transition"
      style="color: var(--color-expense); background: #fef2f2; border: 1px solid #fecaca"
    >
      退出登录
    </button>
  </div>
</template>
