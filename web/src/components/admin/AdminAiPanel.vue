<script setup lang="ts">
/** AI 设置 tab —— 全局模型配置的读写。module 自持设置对象与读失败态。 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import AdminErrorBanner from './AdminErrorBanner.vue'

const toast = useToast()
const globalSettings = ref<Record<string, string>>({})
const error = ref(false)

onMounted(fetchSettings)

async function fetchSettings() {
  try {
    const { data } = await api.get('/admin/settings')
    if (data.code === 0) globalSettings.value = data.data
    error.value = false
  } catch {
    error.value = true
  }
}

async function saveSettings() {
  try {
    await api.put('/admin/settings', globalSettings.value)
    toast.success('设置已保存')
  } catch { /* 提示见 api 拦截器 */ }
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchSettings" />
  <div class="ledger-label mb-3">AI 模型配置</div>
  <div class="surface p-4 space-y-4">
    <div>
      <label class="field-label">API 地址</label>
      <input v-model="globalSettings.ai_base_url" type="text" class="field" placeholder="https://api.openai.com/v1" />
    </div>
    <div>
      <label class="field-label">API Key</label>
      <input v-model="globalSettings.ai_api_key" type="password" class="field" placeholder="sk-..." />
    </div>
    <div>
      <label class="field-label">模型名称</label>
      <input v-model="globalSettings.ai_model" type="text" class="field" placeholder="gpt-4o-mini" />
    </div>
    <button type="button" class="btn btn-primary btn-block" @click="saveSettings">保存设置</button>
  </div>
</template>
