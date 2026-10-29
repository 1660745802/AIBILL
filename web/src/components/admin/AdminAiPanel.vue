<script setup lang="ts">
/** AI 设置 tab —— 全局模型配置的读写。module 自持设置对象与读失败态。 */
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import AdminErrorBanner from './AdminErrorBanner.vue'

const toast = useToast()
const globalSettings = ref<Record<string, string>>({})
// GET 的脱敏值只用于提示，绝不放入可写表单。
const apiKey = ref('')
const apiKeyHint = ref('')
const apiKeyEdited = ref(false)
const saving = ref(false)
const error = ref(false)

onMounted(fetchSettings)

async function fetchSettings() {
  try {
    const { data } = await api.get('/admin/settings')
    if (data.code !== 0) { error.value = true; return }
    const { ai_api_key, ...settings } = data.data
    globalSettings.value = settings
    apiKeyHint.value = ai_api_key || ''
    apiKey.value = ''
    apiKeyEdited.value = false
    error.value = false
  } catch {
    error.value = true
  }
}

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  try {
    const payload = { ...globalSettings.value }
    if (apiKeyEdited.value) payload.ai_api_key = apiKey.value
    const { data } = await api.put('/admin/settings', payload)
    if (data.code !== 0) { toast.error(data.message || '保存失败'); return }
    if (apiKeyEdited.value) {
      apiKeyHint.value = apiKey.value ? '已设置' : ''
      apiKey.value = ''
      apiKeyEdited.value = false
    }
    toast.success('设置已保存')
  } catch { /* 提示见 api 拦截器 */ }
  finally { saving.value = false }
}
</script>

<template>
  <AdminErrorBanner :show="error" @retry="fetchSettings" />
  <div class="ledger-label mb-3">AI 模型配置</div>
  <fieldset :disabled="saving" class="surface p-4 space-y-4">
    <div>
      <label class="field-label">API 地址</label>
      <input v-model="globalSettings.ai_base_url" type="text" class="field" placeholder="https://api.openai.com/v1" />
    </div>
    <div>
      <label class="field-label">API Key</label>
      <input v-model="apiKey" type="password" class="field" placeholder="不修改则留空" autocomplete="new-password" @input="apiKeyEdited = true" />
      <p class="text-xs text-ink-3 mt-1">
        当前：{{ apiKeyHint || '未设置' }}。未编辑则保留原密钥。
        <span v-if="apiKeyEdited && !apiKey">保存后将清空密钥。</span>
      </p>
      <button v-if="apiKeyHint" type="button" class="act mt-1" @click="apiKey = ''; apiKeyEdited = true">清空已保存密钥</button>
    </div>
    <div>
      <label class="field-label">模型名称</label>
      <input v-model="globalSettings.ai_model" type="text" class="field" placeholder="gpt-4o-mini" />
    </div>
    <button type="button" class="btn btn-primary btn-block" :disabled="saving" @click="saveSettings">保存设置</button>
  </fieldset>
</template>
