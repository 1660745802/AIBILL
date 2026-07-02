<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'

const router = useRouter()

type Source = 'wechat' | 'alipay'

const source = ref<Source>('wechat')
const fileContent = ref('')
const fileName = ref('')
const loading = ref(false)
const error = ref('')

// 预览数据
interface PreviewItem {
  type: string
  amount: number
  description: string
  date: string
  category_name?: string
  category_id?: number | null
  account_id?: number | null
}

const previewItems = ref<PreviewItem[]>([])
const stats = ref<{ total: number; skipped: number; errors: number } | null>(null)
const imported = ref(false)
const importLoading = ref(false)

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  fileName.value = file.name
  error.value = ''

  const reader = new FileReader()
  reader.onload = (e) => {
    fileContent.value = e.target?.result as string
  }
  reader.onerror = () => {
    error.value = '文件读取失败'
  }
  reader.readAsText(file, 'utf-8')
}

async function parseCsv() {
  if (!fileContent.value) {
    error.value = '请先选择文件'
    return
  }

  loading.value = true
  error.value = ''
  previewItems.value = []
  stats.value = null

  try {
    const { data } = await api.post('/import/csv', {
      content: fileContent.value,
      source: source.value,
    })
    if (data.code === 0) {
      previewItems.value = data.data.items || []
      stats.value = {
        total: data.data.total ?? previewItems.value.length,
        skipped: data.data.skipped ?? 0,
        errors: data.data.errors ?? 0,
      }
    } else {
      error.value = data.message || '解析失败'
    }
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    loading.value = false
  }
}

async function confirmImport() {
  if (previewItems.value.length === 0) return

  importLoading.value = true
  error.value = ''

  try {
    const { data } = await api.post('/transactions', { items: previewItems.value })
    if (data.code === 0) {
      imported.value = true
    } else {
      error.value = data.message || '导入失败'
    }
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    importLoading.value = false
  }
}

function reset() {
  fileContent.value = ''
  fileName.value = ''
  previewItems.value = []
  stats.value = null
  imported.value = false
  error.value = ''
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'expense': return '支出'
    case 'income': return '收入'
    case 'transfer': return '转账'
    default: return type
  }
}
</script>

<template>
  <div class="pb-4">
    <!-- 标题栏 -->
    <div class="bg-white px-4 py-4 mb-2 flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-900">导入账单</h1>
      <button @click="router.back()" class="text-sm text-gray-500 hover:text-gray-700">返回</button>
    </div>

    <!-- 导入成功 -->
    <div v-if="imported" class="bg-white px-4 py-8 text-center">
      <div class="text-4xl mb-3">✅</div>
      <h2 class="text-lg font-bold text-gray-900 mb-2">导入成功</h2>
      <p class="text-sm text-gray-500 mb-6">
        已成功导入 {{ previewItems.length }} 条记录
      </p>
      <div class="flex gap-3 justify-center">
        <button
          @click="router.push('/transactions')"
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          查看流水
        </button>
        <button
          @click="reset"
          class="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          继续导入
        </button>
      </div>
    </div>

    <template v-else>
      <!-- 格式选择 -->
      <div class="bg-white px-4 py-4 mb-2">
        <h3 class="text-sm font-medium text-gray-700 mb-3">选择账单格式</h3>
        <div class="flex gap-2">
          <button
            @click="source = 'wechat'"
            class="flex-1 py-2 text-sm rounded-lg border transition-colors"
            :class="source === 'wechat' ? 'bg-green-50 border-green-300 text-green-700' : 'border-gray-200 text-gray-600'"
          >
            💬 微信
          </button>
          <button
            @click="source = 'alipay'"
            class="flex-1 py-2 text-sm rounded-lg border transition-colors"
            :class="source === 'alipay' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-600'"
          >
            💰 支付宝
          </button>
        </div>
      </div>

      <!-- 文件上传 -->
      <div class="bg-white px-4 py-4 mb-2">
        <h3 class="text-sm font-medium text-gray-700 mb-3">上传 CSV 文件</h3>
        <label class="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-gray-50 transition-colors">
          <div class="text-center">
            <div v-if="fileName" class="text-sm text-gray-700">📄 {{ fileName }}</div>
            <template v-else>
              <div class="text-2xl text-gray-400 mb-1">📁</div>
              <div class="text-xs text-gray-500">点击选择 CSV 文件</div>
            </template>
          </div>
          <input
            type="file"
            accept=".csv"
            class="hidden"
            @change="handleFileChange"
          />
        </label>

        <button
          v-if="fileContent && !previewItems.length"
          @click="parseCsv"
          :disabled="loading"
          class="w-full mt-3 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {{ loading ? '解析中...' : '解析文件' }}
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="error" class="bg-white px-4 py-3 mb-2">
        <div class="text-sm text-red-600 bg-red-50 p-2 rounded">{{ error }}</div>
      </div>

      <!-- 预览表格 -->
      <div v-if="previewItems.length > 0" class="bg-white px-4 py-4 mb-2">
        <!-- 统计 -->
        <div v-if="stats" class="flex gap-4 mb-3 text-xs text-gray-500">
          <span>总条数: <strong class="text-gray-700">{{ stats.total }}</strong></span>
          <span>可导入: <strong class="text-green-600">{{ previewItems.length }}</strong></span>
          <span v-if="stats.skipped">跳过: <strong class="text-yellow-600">{{ stats.skipped }}</strong></span>
          <span v-if="stats.errors">错误: <strong class="text-red-600">{{ stats.errors }}</strong></span>
        </div>

        <!-- 表格 -->
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200">
                <th class="text-left py-2 text-xs text-gray-500 font-medium">日期</th>
                <th class="text-left py-2 text-xs text-gray-500 font-medium">类型</th>
                <th class="text-right py-2 text-xs text-gray-500 font-medium">金额</th>
                <th class="text-left py-2 pl-3 text-xs text-gray-500 font-medium">描述</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, idx) in previewItems.slice(0, 50)"
                :key="idx"
                class="border-b border-gray-50"
              >
                <td class="py-2 text-xs text-gray-600 whitespace-nowrap">{{ item.date }}</td>
                <td class="py-2">
                  <span
                    class="text-xs px-1.5 py-0.5 rounded"
                    :class="{
                      'bg-red-50 text-red-600': item.type === 'expense',
                      'bg-green-50 text-green-600': item.type === 'income',
                      'bg-blue-50 text-blue-600': item.type === 'transfer',
                    }"
                  >
                    {{ getTypeLabel(item.type) }}
                  </span>
                </td>
                <td class="py-2 text-right text-xs font-medium text-gray-800">
                  ¥{{ formatAmount(item.amount) }}
                </td>
                <td class="py-2 pl-3 text-xs text-gray-600 max-w-32 truncate">
                  {{ item.description }}
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="previewItems.length > 50" class="text-center text-xs text-gray-400 mt-2">
            仅显示前 50 条，共 {{ previewItems.length }} 条
          </div>
        </div>

        <!-- 确认导入 -->
        <div class="flex gap-3 mt-4">
          <button
            @click="confirmImport"
            :disabled="importLoading"
            class="flex-1 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {{ importLoading ? '导入中...' : `确认导入 ${previewItems.length} 条` }}
          </button>
          <button
            @click="reset"
            class="px-4 py-2.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
