<script setup lang="ts">
/**
 * 未解析裁决 tab —— AI 失败 = 不确定的人工出口（P1 列表 + P2 裁决）。
 * module 自持筛选、裁决理由输入与读失败态。
 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { formatLocalTime } from '@/utils/date'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminStat from './AdminStat.vue'

const toast = useToast()

const triageFilter = ref({ days: '7', channel: '', action: '', includeRaw: false })
const triageStats = ref<any>(null)
const loadingTriage = ref(false)
const triageSubmitting = ref<number | null>(null)
/** 每条的理由输入（裁决必填，供审计/复盘） */
const triageReasons = ref<Record<number, string>>({})
const error = ref(false)

onMounted(() => fetchTriage())

async function fetchTriage() {
  loadingTriage.value = true
  try {
    const params = new URLSearchParams({ days: triageFilter.value.days })
    if (triageFilter.value.channel) params.set('channel', triageFilter.value.channel)
    if (triageFilter.value.action) params.set('triage', triageFilter.value.action)
    if (triageFilter.value.includeRaw) params.set('include_raw', '1')
    const { data } = await api.get(`/admin/unparsed?${params.toString()}`)
    triageStats.value = data.code === 0 ? data.data : null
    error.value = false
  } catch {
    error.value = true
  } finally { loadingTriage.value = false }
}

/** 三个动作：只写裁决记录（服务端不写账、不回推客户端） */
async function submitTriage(id: number, action: 'mark_bill' | 'mark_not_bill' | 'mark_rule_missing') {
  const reason = (triageReasons.value[id] ?? '').trim()
  if (!reason) { toast.error('请先填写裁决理由'); return }
  triageSubmitting.value = id
  try {
    await api.post(`/admin/unparsed/${id}/triage`, { action, reason })
    toast.success('裁决已记录')
    await fetchTriage()
  } catch { /* 拦截器已提示 */ }
  finally { triageSubmitting.value = null }
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchTriage" />

  <div class="flex items-center justify-between gap-3 flex-wrap">
    <span class="ledger-label ledger-label-solid">未解析裁决</span>
    <div class="flex items-center gap-2 flex-wrap">
      <select v-model="triageFilter.days" class="field w-auto" @change="fetchTriage()">
        <option value="1">今天</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
        <option value="90">近 90 天</option>
      </select>
      <select v-model="triageFilter.channel" class="field w-auto" @change="fetchTriage()">
        <option value="">全部渠道</option>
        <option value="nls">nls</option>
        <option value="sms">sms</option>
        <option value="a11y">a11y</option>
        <option value="manual">manual</option>
      </select>
      <select v-model="triageFilter.action" class="field w-auto" @change="fetchTriage()">
        <option value="">全部裁决状态</option>
        <option value="mark_bill">已判「是账」</option>
        <option value="mark_not_bill">已判「不是账」</option>
        <option value="mark_rule_missing">判据缺失（规则候选）</option>
      </select>
      <label class="flex items-center gap-1.5 text-xs text-ink-2 whitespace-nowrap">
        <input type="checkbox" v-model="triageFilter.includeRaw" @change="fetchTriage()" />
        显示原文（写审计）
      </label>
    </div>
  </div>

  <p class="text-xs text-ink-3 leading-relaxed">
    AI <b>失败 = 不确定</b>（客户端不落待审、不打扰用户，只在这里留痕）。默认只给<b>脱敏预览</b>（首 60 字）；
    勾选「显示原文」才取全文，且服务端会写审计。裁决<b>只落记录</b>：<b>不写账、不回推客户端</b>；
    「不是账 / 判据缺失」充当规则/语料候选池（最终改动仍走 <code>rules.json</code> 发布流程）。
  </p>

  <div v-if="loadingTriage" class="text-center py-8 text-xs text-ink-3">加载中…</div>
  <EmptyState
    v-else-if="!triageStats"
    icon="search"
    title="读不到未解析记录"
    description="服务端未返回数据，或窗口内没有 AI 不可用的失败记录。"
    compact
  />
  <template v-else>
    <section>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat :value="triageStats.summary.total" tone="action">窗口内失败总数</AdminStat>
        <AdminStat
          v-for="r in (triageStats.summary.by_failure_code ?? []).slice(0, 3)"
          :key="r.failure_code"
          :value="r.count"
          tone="warn"
          label-class="mono truncate"
        >{{ r.failure_code }}</AdminStat>
      </div>
      <div v-if="triageStats.summary.by_channel?.length" class="sheet mt-3">
        <div v-for="c in triageStats.summary.by_channel" :key="c.channel" class="sheet-row">
          <span class="text-sm text-ink-1 w-16">{{ c.channel }}</span>
          <span class="flex-1 text-xs text-ink-3 amt">{{ c.count }} 条</span>
        </div>
      </div>
    </section>

    <EmptyState
      v-if="triageStats.items.length === 0"
      icon="check"
      title="窗口内没有未解析失败"
      compact
    />
    <div v-else class="space-y-2">
      <div v-for="it in triageStats.items" :key="it.id" class="surface p-3">
        <div class="flex items-center gap-2 flex-wrap text-xs text-ink-3">
          <span class="badge badge-warn">{{ it.failure_code }}</span>
          <span v-if="it.channel" class="badge">{{ it.channel }}</span>
          <span v-if="it.source_package" class="truncate max-w-40">{{ it.source_package }}</span>
          <span class="amt">#{{ it.id }}</span>
          <span>{{ formatLocalTime(it.created_at) }}</span>
          <span v-if="it.attempts > 1">调模型 {{ it.attempts }} 次</span>
        </div>
        <div class="text-sm text-ink-1 mt-2 break-words">{{ it.raw_input ?? it.text_preview }}</div>
        <div v-if="!it.raw_input && it.raw_input_len > it.text_preview.length" class="text-xs text-ink-4 mt-1">
          已脱敏（共 {{ it.raw_input_len }} 字）
        </div>
        <div v-if="it.triage" class="text-xs text-ink-3 mt-2">
          当前裁决：<span class="badge badge-ink">{{ it.triage.action }}</span>
          <span class="ml-1">{{ it.triage.reason }}</span>
        </div>
        <div class="flex items-center gap-2 mt-2 flex-wrap">
          <input v-model="triageReasons[it.id]" class="field flex-1 min-w-40" placeholder="裁决理由（必填）" />
          <button class="btn btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_bill')">是账</button>
          <button class="btn btn-outline btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_not_bill')">不是账</button>
          <button class="btn btn-outline btn-sm" :disabled="triageSubmitting === it.id" @click="submitTriage(it.id, 'mark_rule_missing')">判据缺失</button>
        </div>
      </div>
    </div>
  </template>
</template>
