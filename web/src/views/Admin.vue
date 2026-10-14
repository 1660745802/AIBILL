<script setup lang="ts">
/**
 * 管理面板 —— **壳**。
 *
 * 只负责三件事：左侧/手机端导航、tab 与 URL 的同步、把选中的 tab 渲染成对应的 panel module。
 * 每个 tab 的数据、请求、错误态、弹窗都在自己的 panel 里（`components/admin/Admin*Panel.vue`），
 * 壳不再持有任何一处 tab 的状态——这是从 2065 行单文件拆出来的核心：
 * 「哪个请求失败」「什么时候加载」是 tab 内部知识，不该让壳替它判断。
 *
 * panel 在 `v-if` 命中时才挂载，因此**深链（`/admin?tab=xxx`）与切 tab 走同一条加载路径**：
 * panel 自己的 `onMounted` 拉数据。
 */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppIcon from '@/components/ui/AppIcon.vue'
import type { TabKey } from '@/components/admin/types'
import AdminOverviewPanel from '@/components/admin/AdminOverviewPanel.vue'
import AdminUsersPanel from '@/components/admin/AdminUsersPanel.vue'
import AdminAiPanel from '@/components/admin/AdminAiPanel.vue'
import AdminQualityPanel from '@/components/admin/AdminQualityPanel.vue'
import AdminAutomationPanel from '@/components/admin/AdminAutomationPanel.vue'
import AdminTriagePanel from '@/components/admin/AdminTriagePanel.vue'
import AdminSamplesPanel from '@/components/admin/AdminSamplesPanel.vue'
import AdminLogsPanel from '@/components/admin/AdminLogsPanel.vue'
import AdminRulesPanel from '@/components/admin/AdminRulesPanel.vue'
import AdminReleasePanel from '@/components/admin/AdminReleasePanel.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

/* ── 导航按「问题」分三组（与侧栏同一原则），而不是按接口 ──
   上一版是 9 个 tab 平铺：“解析质量 / 自动化对照 / 系统日志”概念上同族却并列，
   “邀请码”本是“用户与访问”的子项，手机端还得横滑 9 个 chip。
   现在：访问（用户+邀请码）· 自动化（质量/对照/规则/AI 设置）· 运维（概览/日志/App 更新）。 */
interface NavItem { key: TabKey; label: string; short: string; icon: string }
const navGroups: { key: string; label: string; items: NavItem[] }[] = [
  {
    key: 'access',
    label: '访问',
    items: [{ key: 'users', label: '用户与邀请码', short: '用户', icon: 'users' }],
  },
  {
    key: 'automation',
    label: '自动化',
    items: [
      { key: 'quality', label: '解析质量', short: '质量', icon: 'search' },
      { key: 'triage', label: '未解析裁决', short: '裁决', icon: 'check' },
      { key: 'samples', label: '被拦样本', short: '样本', icon: 'filter' },
      { key: 'automation', label: '自动化对照', short: '自动化', icon: 'spark' },
      { key: 'rules', label: '通知规则', short: '规则', icon: 'code' },
      { key: 'ai', label: 'AI 设置', short: 'AI', icon: 'spark' },
    ],
  },
  {
    key: 'ops',
    label: '运维',
    items: [
      { key: 'overview', label: '概览', short: '概览', icon: 'overview' },
      { key: 'logs', label: '系统日志', short: '日志', icon: 'list' },
      { key: 'release', label: 'App 更新', short: '更新', icon: 'upload' },
    ],
  },
]
/** 手机端 chip 用扁平列表（底栏塞不进组） */
const navItems: NavItem[] = navGroups.flatMap((g) => g.items)

const TAB_KEYS: TabKey[] = navItems.map((i) => i.key)

/* tab 落 URL（`/admin?tab=xxx`）：可刷新、可深链、可分享。
   只接受已知 key，URL 里塞奇怪值就回退到「概览」。 */
function tabFromQuery(): TabKey {
  const t = String(route.query.tab ?? '')
  return (TAB_KEYS as string[]).includes(t) ? (t as TabKey) : 'overview'
}
const activeTab = ref<TabKey>(tabFromQuery())

/* 浏览器前进/后退会改 URL 但不走 switchTab → 这里补上反向同步 */
watch(
  () => route.query.tab,
  (v) => {
    const t = String(v ?? '')
    const key = (TAB_KEYS as string[]).includes(t) ? (t as TabKey) : 'overview'
    if (key !== activeTab.value) switchTab(key)
  },
)

function switchTab(key: TabKey) {
  activeTab.value = key
  // replace 避免每次切 tab 都往历史里塞一条
  router.replace({ query: { ...route.query, tab: key } })
}
</script>

<template>
  <div>
    <div class="flex flex-col md:flex-row md:gap-6">
      <!-- ≥md：左侧 192px sticky 子导航 -->
      <aside class="hidden md:block shrink-0" style="width: 192px">
        <div class="admin-nav">
          <h1 class="page-title mb-0.5">管理面板</h1>
          <p class="text-xs text-ink-3 mb-4">系统管理与监控</p>
          <nav class="flex flex-col gap-3">
            <div v-for="group in navGroups" :key="group.key">
              <div class="admin-nav-group">{{ group.label }}</div>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="admin-nav-item"
                :class="activeTab === item.key ? 'admin-nav-item-active' : ''"
                @click="switchTab(item.key)"
              >
                <AppIcon :name="item.icon" :size="16" />
                <span>{{ item.label }}</span>
              </button>
            </div>
          </nav>
        </div>
      </aside>

      <!-- <md：横向滚动 chip -->
      <div class="md:hidden mb-4">
        <h1 class="page-title mb-3">管理面板</h1>
        <div class="scroll-x flex gap-2 pb-1">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="chip shrink-0"
            :class="activeTab === item.key ? 'chip-active' : ''"
            @click="switchTab(item.key)"
          >{{ item.short }}</button>
        </div>
      </div>

      <!-- 右侧内容区：每个 tab 一个 panel module（数据/请求/错误态都在里面） -->
      <div class="flex-1 min-w-0" v-if="auth.isAdmin">
        <AdminOverviewPanel v-if="activeTab === 'overview'" @navigate="switchTab" />
        <AdminUsersPanel v-else-if="activeTab === 'users'" />
        <AdminAiPanel v-else-if="activeTab === 'ai'" />
        <AdminQualityPanel v-else-if="activeTab === 'quality'" />
        <AdminAutomationPanel v-else-if="activeTab === 'automation'" />
        <AdminTriagePanel v-else-if="activeTab === 'triage'" />
        <AdminSamplesPanel v-else-if="activeTab === 'samples'" />
        <AdminLogsPanel v-else-if="activeTab === 'logs'" />
        <AdminRulesPanel v-else-if="activeTab === 'rules'" />
        <AdminReleasePanel v-else-if="activeTab === 'release'" />
      </div>
    </div>
  </div>
</template>
