<script setup lang="ts">
/**
 * App 更新 tab —— APK 自托管分发（当前激活版本 / 上传新版本 / 版本历史）。
 * module 自持上传表单、分页与读失败态。
 */
import { ref, computed, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import { formatLocalTime } from '@/utils/date'
import EmptyState from '@/components/ui/EmptyState.vue'
import AdminErrorBanner from './AdminErrorBanner.vue'
import AdminPager from './AdminPager.vue'

const toast = useToast()
const confirm = useConfirm()

const appUpdates = ref<any[]>([])
const appUpdatesTotal = ref(0)
const appUpdatesPage = ref(1)
const appUpdatesPageSize = 20
const loadingUpdates = ref(false)
const uploadingApk = ref(false)
const apkFile = ref<File | null>(null)
const apkForm = ref({ version_name: '', version_code: '', changelog: '', force_update: false })
const activeUpdate = computed(() => appUpdates.value.find((u) => u.is_active) ?? null)
const error = ref(false)

onMounted(() => fetchAppUpdates(1))

async function fetchAppUpdates(page = 1) {
  loadingUpdates.value = true
  try {
    const { data } = await api.get(`/admin/updates?page=${page}&page_size=${appUpdatesPageSize}`)
    if (data.code === 0) {
      appUpdates.value = data.data.items
      appUpdatesTotal.value = data.data.total
      appUpdatesPage.value = data.data.page
    }
    error.value = false
  } catch {
    error.value = true
  }
  finally { loadingUpdates.value = false }
}

function pickApk(e: Event): void {
  apkFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function uploadApk(): Promise<void> {
  if (!apkFile.value) { toast.error('请先选择 APK 文件'); return }
  if (!apkForm.value.version_name.trim()) { toast.error('versionName 必填'); return }
  const code = Number(apkForm.value.version_code)
  if (!Number.isInteger(code) || code <= 0) { toast.error('versionCode 必须是正整数'); return }
  /* 客户端侧先提醒 §3.8 的纪律（服务端也会拦）：versionCode 必须**严格递增且唯一**，
     跳号正常。这里只做提示，不代替服务端校验。 */
  if (activeUpdate.value && code <= activeUpdate.value.version_code) {
    toast.error(`versionCode 必须大于当前激活版本（${activeUpdate.value.version_code}）`)
    return
  }
  const ok = await confirm({
    title: '上传并激活该版本？',
    body:
      `上传后会立即对所有客户端生效：低于 versionCode ${code} 的客户端会看到更新` +
      (apkForm.value.force_update
        ? '，且因为勾选了「强制更新」，它们会被要求升级。'
        : '。'),
    confirmText: '上传并激活',
    danger: apkForm.value.force_update,
  })
  if (!ok) return
  uploadingApk.value = true
  try {
    const fd = new FormData()
    fd.append('apk_file', apkFile.value)
    fd.append('version_name', apkForm.value.version_name.trim())
    fd.append('version_code', String(code))
    fd.append('changelog', apkForm.value.changelog)
    fd.append('force_update', apkForm.value.force_update ? 'true' : 'false')
    // APK 可能上百 MB → 覆盖默认 10s 超时
    const { data } = await api.post('/admin/updates', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    })
    if (data.code === 0) {
      toast.success('版本已上传并激活')
      apkForm.value = { version_name: '', version_code: '', changelog: '', force_update: false }
      apkFile.value = null
      await fetchAppUpdates(1)
    }
  } catch { /* 提示见 api 拦截器 */ }
  finally { uploadingApk.value = false }
}

function formatBytes(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchAppUpdates(appUpdatesPage)" />

  <section>
    <div class="ledger-label mb-3">当前激活版本</div>
    <EmptyState
      v-if="!activeUpdate"
      icon="upload"
      title="服务端没有激活版本"
      description="客户端会回落到 GitHub Release；上传一个 APK 后即从服务端分发。"
      compact
    />
    <div v-else class="surface p-4">
      <div class="flex items-center justify-between gap-2">
        <div class="text-sm font-medium text-ink-1">
          {{ activeUpdate.version_name }}
          <span class="badge badge-ink ml-1.5">versionCode {{ activeUpdate.version_code }}</span>
          <span v-if="activeUpdate.force_update" class="badge badge-warn ml-1.5">强制更新</span>
        </div>
        <span class="text-xs text-ink-3 amt">{{ formatBytes(activeUpdate.apk_size) }}</span>
      </div>
      <div v-if="activeUpdate.changelog" class="text-xs text-ink-2 mt-2 whitespace-pre-wrap">{{ activeUpdate.changelog }}</div>
      <div class="text-xs text-ink-4 mt-2 amt">{{ formatLocalTime(activeUpdate.created_at) }}</div>
    </div>
  </section>

  <section>
    <div class="ledger-label mb-3">上传新版本</div>
    <div class="surface p-4 space-y-3">
      <div>
        <label class="field-label">APK 文件</label>
        <input type="file" accept=".apk" class="field" @change="pickApk" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label">versionName</label>
          <input v-model="apkForm.version_name" class="field" placeholder="例如：1.7.0" />
        </div>
        <div>
          <label class="field-label">versionCode</label>
          <input v-model="apkForm.version_code" class="field" inputmode="numeric" placeholder="例如：25" />
        </div>
      </div>
      <div>
        <label class="field-label">更新说明</label>
        <textarea v-model="apkForm.changelog" rows="2" class="field"></textarea>
      </div>
      <label class="flex items-center gap-2 text-sm text-ink-1">
        <input v-model="apkForm.force_update" type="checkbox" />
        强制更新（低于此 versionCode 的客户端会被要求升级）
      </label>
      <div class="text-xs text-ink-3">versionCode 必须**严格递增且唯一**（跳号正常）—— 见 ARCHITECTURE §3.8。</div>
      <button
        type="button"
        class="btn btn-primary btn-block"
        :disabled="uploadingApk || !apkFile || !apkForm.version_name || !apkForm.version_code"
        @click="uploadApk"
      >{{ uploadingApk ? '上传中…' : '上传并激活' }}</button>
    </div>
  </section>

  <section>
    <div class="ledger-label mb-3">版本历史（共 {{ appUpdatesTotal }} 个）</div>
    <div v-if="loadingUpdates" class="text-center py-6 text-xs text-ink-3">加载中…</div>
    <EmptyState
      v-else-if="appUpdates.length === 0"
      icon="upload"
      title="还没有上传过版本"
      description="上传后，已发布的 Android 客户端会发现更新。"
      compact
    />
    <div v-else class="sheet">
      <div v-for="u in appUpdates" :key="u.id" class="sheet-row">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-ink-1">
            {{ u.version_name }}
            <span v-if="u.is_active" class="badge badge-ink ml-1.5">激活</span>
            <span v-if="u.force_update" class="badge badge-warn ml-1.5">强制</span>
          </div>
          <div class="text-xs text-ink-3 mt-0.5 amt">code {{ u.version_code }} · {{ formatBytes(u.apk_size) }} · {{ formatLocalTime(u.created_at) }}</div>
        </div>
      </div>
    </div>
    <AdminPager
      v-if="appUpdatesTotal > appUpdatesPageSize"
      :page="appUpdatesPage"
      :total="appUpdatesTotal"
      :total-pages="Math.ceil(appUpdatesTotal / appUpdatesPageSize)"
      @change="fetchAppUpdates"
    />
  </section>
</template>
