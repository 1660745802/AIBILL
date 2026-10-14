<script setup lang="ts">
/** 系统日志 tab —— 级别/模块/时间筛选 + 分页。module 自持筛选与读失败态。 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { formatLocalTime } from '@/utils/date'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminPager from './AdminPager.vue'

const appLogs = ref<any[]>([])
const appLogsPagination = ref({ page: 1, page_size: 50, total: 0 })
const appLogsFilter = ref({ level: '', module: '', days: '7' })
const loadingAppLogs = ref(false)
const error = ref(false)

onMounted(() => fetchAppLogs())

async function fetchAppLogs(page = 1) {
  loadingAppLogs.value = true
  try {
    const params: any = { page, page_size: appLogsPagination.value.page_size, days: appLogsFilter.value.days }
    if (appLogsFilter.value.level) params.level = appLogsFilter.value.level
    if (appLogsFilter.value.module) params.module = appLogsFilter.value.module
    const { data } = await api.get('/admin/logs', { params })
    if (data.code === 0) {
      appLogs.value = data.data.items ?? []
      appLogsPagination.value = { ...appLogsPagination.value, ...(data.data.pagination ?? {}) }
    }
    error.value = false
  } catch {
    error.value = true
  }
  finally { loadingAppLogs.value = false }
}

function logLevelBadge(level: string): string {
  const map: Record<string, string> = { info: 'badge-info', warn: 'badge-warn', error: 'badge-expense' }
  return map[level] || 'badge'
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchAppLogs(appLogsPagination.page)" />

  <div class="ledger-label mb-3">系统日志</div>
  <div class="flex gap-2 mb-3 flex-wrap">
    <select v-model="appLogsFilter.level" class="field w-auto" @change="fetchAppLogs(1)">
      <option value="">全部级别</option>
      <option value="info">INFO</option>
      <option value="warn">WARN</option>
      <option value="error">ERROR</option>
    </select>
    <select v-model="appLogsFilter.days" class="field w-auto" @change="fetchAppLogs(1)">
      <option value="1">今天</option>
      <option value="7">近 7 天</option>
      <option value="30">近 30 天</option>
    </select>
    <input v-model="appLogsFilter.module" placeholder="模块名" class="field w-28" @change="fetchAppLogs(1)" />
  </div>

  <div v-if="loadingAppLogs" class="text-center py-6 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="appLogs.length === 0"
    icon="list"
    title="暂无日志"
    description="调整上方的级别或时间范围，或等待系统产生新日志。"
    compact
  />
  <div v-else class="surface surface-flush">
    <div v-for="log in appLogs" :key="log.id" class="admin-log-row">
      <span class="badge" :class="logLevelBadge(log.level)">{{ log.level.toUpperCase() }}</span>
      <span class="mono text-ink-3 shrink-0">[{{ log.module }}]</span>
      <span class="text-xs text-ink-2 flex-1 break-all">{{ log.message }}</span>
      <span class="text-xs text-ink-4 shrink-0 amt">{{ formatLocalTime(log.created_at) }}</span>
    </div>
  </div>

  <AdminPager
    v-if="appLogsPagination.total > 50"
    :page="appLogsPagination.page"
    :total="appLogsPagination.total"
    :total-pages="1"
    :show-total-pages="false"
    @change="fetchAppLogs"
  />
</template>
