<script setup lang="ts">
/**
 * 通知规则 tab —— 只读历史版本 + 激活/回滚（不做在线编辑，避免与文件真源双写）。
 * module 自持版本列表、预览弹窗与读失败态。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { formatLocalTime } from '@/utils/date'
import BaseModal from '@/components/ui/BaseModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'

const toast = useToast()

const notifRules = ref<any[]>([])
const loadingRules = ref(false)
const showRulePreview = ref<any>(null)
const error = ref(false)

onMounted(fetchNotifRules)

async function fetchNotifRules() {
  loadingRules.value = true
  try {
    const { data } = await api.get('/admin/notification-rules')
    if (data.code === 0) notifRules.value = data.data.items
    error.value = false
  } catch {
    error.value = true
  }
  finally { loadingRules.value = false }
}

async function activateRule(id: number) {
  try {
    const { data } = await api.put(`/admin/notification-rules/${id}/activate`)
    if (data.code === 0) {
      toast.success(data.message)
      await fetchNotifRules()
    }
  } catch { /* 提示见 api 拦截器 */ }
}

/* 详情统一走 BaseModal（上一版规则预览是内联展开，与解析详情/用户明细两种形态并存） */
function openRulePreview(rule: any): void {
  showRulePreview.value = rule
}

function formatRuleJson(rule: any): string {
  if (!rule.rules) return '{}'
  try {
    const parsed = typeof rule.rules === 'string' ? JSON.parse(rule.rules) : rule.rules
    return JSON.stringify(parsed, null, 2)
  } catch {
    return String(rule.rules)
  }
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchNotifRules" />

  <section>
    <div class="ledger-label mb-3">真源与发布</div>
    <div class="surface p-4">
      <p class="text-xs text-ink-2 leading-relaxed">
        规则内容真源是仓库文件 <code class="mono">server/config/rules.json</code>（改动走
        commit → 重启/重建，服务端启动时会校验并发布）。<br />
        本页只做<strong>查看历史版本</strong>与<strong>激活/回滚</strong>，<strong>不提供在线编辑</strong>——
        避免与文件双写、也避免发布一份与仓库不同的内容。详见 ARCHITECTURE §3.7。
      </p>
    </div>
  </section>

  <section>
    <div class="ledger-label mb-3">规则版本</div>
    <div v-if="loadingRules" class="text-center py-6 text-xs text-ink-3">加载中…</div>
    <EmptyState
      v-else-if="notifRules.length === 0"
      icon="code"
      title="暂无规则版本"
      description="在上方新建一个 JSON 规则版本，激活后用于通知自动记账解析。"
      compact
    />
    <div v-else class="space-y-2">
      <div
        v-for="rule in notifRules"
        :key="rule.id"
        class="admin-rule"
        :class="rule.is_active ? 'admin-rule-active' : ''"
      >
        <div class="flex items-center justify-between gap-2">
          <div>
            <div class="text-sm font-medium text-ink-1">
              版本 {{ rule.version }}
              <span v-if="rule.is_active" class="badge badge-ink ml-1.5">当前激活</span>
            </div>
            <div class="text-xs text-ink-3 mt-0.5 amt">
              {{ formatLocalTime(rule.created_at) }}
              <span v-if="rule.content_hash" class="ml-2 mono">hash {{ String(rule.content_hash).slice(0, 12) }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" class="act" @click="openRulePreview(rule)">预览</button>
            <button
              v-if="!rule.is_active"
              type="button"
              class="act"
              @click="activateRule(rule.id)"
            >激活</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 规则版本预览（与解析详情/用户明细同一种详情面） -->
  <BaseModal
    :show="!!showRulePreview"
    :title="showRulePreview ? `规则版本 ${showRulePreview.version}` : '规则版本'"
    size="lg"
    @close="showRulePreview = null"
  >
    <div v-if="showRulePreview" class="space-y-3">
      <div class="flex items-center gap-2 text-xs text-ink-3 amt">
        <span v-if="showRulePreview.is_active" class="badge badge-ink">当前激活</span>
        <span v-if="showRulePreview.content_hash" class="mono truncate">
          content_hash {{ showRulePreview.content_hash }}
        </span>
        <span class="ml-auto shrink-0">{{ formatLocalTime(showRulePreview.created_at) }}</span>
      </div>
      <pre class="admin-json-view scroll-thin mono">{{ formatRuleJson(showRulePreview) }}</pre>
    </div>
  </BaseModal>
</template>
