<script setup lang="ts">
import { ref, computed } from 'vue'
import api from '@/api/index'

type AnalysisType = 'overview' | 'spending' | 'forecast'

interface AnalysisResult {
  type: AnalysisType
  analysis: string
  data_summary: {
    months: Array<{ month: string; expense: number; income: number }>
    categories: Array<{ name: string; icon: string; total: number }>
    net_worth: number
    subscription_monthly: number
  }
  generated_at: string
}

const selectedType = ref<AnalysisType>('overview')
const loading = ref(false)
const error = ref('')
const currentResult = ref<AnalysisResult | null>(null)
const history = ref<AnalysisResult[]>([])
const showDataSummary = ref(false)

const typeOptions = [
  { value: 'overview' as const, icon: '📊', title: '全面分析', desc: '财务健康度评估', color: 'from-blue-500 to-indigo-500' },
  { value: 'spending' as const, icon: '🛒', title: '消费分析', desc: '消费结构与优化', color: 'from-emerald-500 to-teal-500' },
  { value: 'forecast' as const, icon: '🔮', title: '未来预测', desc: '趋势预测与规划', color: 'from-purple-500 to-pink-500' },
]

const formattedAnalysis = computed(() => {
  if (!currentResult.value) return []
  const text = currentResult.value.analysis
  // Split into paragraphs by double newlines or section headers
  const lines = text.split('\n')
  const sections: Array<{ type: 'header' | 'bullet' | 'text'; content: string }> = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^[📊💡✅🔍📈💰📅🎯🗓️]/.test(trimmed) || /^\d+\./.test(trimmed)) {
      sections.push({ type: 'header', content: trimmed })
    } else if (/^[-•·]/.test(trimmed)) {
      sections.push({ type: 'bullet', content: trimmed.replace(/^[-•·]\s*/, '') })
    } else {
      sections.push({ type: 'text', content: trimmed })
    }
  }
  return sections
})

async function generateAnalysis() {
  loading.value = true
  error.value = ''
  currentResult.value = null

  try {
    const { data } = await api.post('/stats/analysis', { type: selectedType.value }, { timeout: 60000 })
    if (data.code === 0) {
      currentResult.value = data.data
      // Add to history (max 3)
      history.value = [data.data, ...history.value.filter(h => h.type !== data.data.type)].slice(0, 3)
    } else {
      error.value = data.message || '分析失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '网络错误或AI超时，请重试'
  } finally {
    loading.value = false
  }
}

function loadFromHistory(result: AnalysisResult) {
  currentResult.value = result
  selectedType.value = result.type
}

function formatAmount(cents: number): string {
  const yuan = cents / 100
  return yuan >= 10000 ? `${(yuan / 10000).toFixed(1)}万` : yuan.toFixed(0)
}

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

function typeLabel(type: AnalysisType): string {
  const map = { overview: '全面分析', spending: '消费分析', forecast: '未来预测' }
  return map[type]
}
</script>

<template>
  <div class="pb-6 px-4 pt-4">
    <!-- 头部 -->
    <div class="mb-6">
      <h1 class="text-xl font-bold text-gray-900">🧠 AI 财务分析</h1>
      <p class="text-sm text-gray-500 mt-1">基于你的财务数据，AI 为你提供专业分析</p>
    </div>

    <!-- 分析类型选择 -->
    <div class="grid grid-cols-3 gap-2.5 mb-5">
      <button
        v-for="opt in typeOptions"
        :key="opt.value"
        @click="selectedType = opt.value"
        class="relative p-3 rounded-xl border-2 text-center transition-all duration-200"
        :class="selectedType === opt.value
          ? 'border-transparent shadow-md scale-[1.02]'
          : 'border-gray-100 hover:border-gray-200 bg-white'"
      >
        <!-- 选中时的渐变背景 -->
        <div
          v-if="selectedType === opt.value"
          class="absolute inset-0 rounded-xl opacity-10 bg-gradient-to-br"
          :class="opt.color"
        ></div>
        <div class="relative">
          <div class="text-2xl mb-1">{{ opt.icon }}</div>
          <div class="text-xs font-semibold text-gray-800">{{ opt.title }}</div>
          <div class="text-[10px] text-gray-400 mt-0.5">{{ opt.desc }}</div>
        </div>
        <!-- 选中指示器 -->
        <div
          v-if="selectedType === opt.value"
          class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-gradient-to-br flex items-center justify-center"
          :class="opt.color"
        >
          <span class="text-white text-[10px]">✓</span>
        </div>
      </button>
    </div>

    <!-- 生成按钮 -->
    <button
      @click="generateAnalysis"
      :disabled="loading"
      class="w-full py-3.5 rounded-xl font-medium text-white shadow-md transition-all disabled:opacity-60 disabled:shadow-none"
      :class="loading ? 'bg-gray-400' : 'bg-gradient-to-r from-blue-500 to-indigo-600 hover:shadow-lg'"
    >
      <span v-if="loading" class="inline-flex items-center gap-2">
        <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
        AI 分析中...
      </span>
      <span v-else>✨ 开始分析</span>
    </button>

    <!-- 历史记录 -->
    <div v-if="history.length > 0 && !loading" class="flex gap-2 mt-3 overflow-x-auto pb-1">
      <button
        v-for="h in history"
        :key="h.generated_at"
        @click="loadFromHistory(h)"
        class="px-3 py-1.5 bg-gray-50 border border-gray-100 rounded-lg text-[11px] text-gray-500 hover:bg-gray-100 whitespace-nowrap shrink-0"
        :class="currentResult?.generated_at === h.generated_at ? 'border-blue-200 bg-blue-50 text-blue-600' : ''"
      >
        {{ typeLabel(h.type) }} · {{ h.generated_at.slice(11, 16) }}
      </button>
    </div>

    <!-- 错误 -->
    <div v-if="error" class="mt-4 p-3 bg-red-50 border border-red-100 rounded-xl text-sm text-red-600 flex items-start gap-2">
      <span>⚠️</span>
      <div>
        <div>{{ error }}</div>
        <button @click="generateAnalysis" class="mt-1 text-xs text-red-500 underline">重试</button>
      </div>
    </div>

    <!-- 分析结果 -->
    <div v-if="currentResult && !loading" class="mt-5">
      <!-- 主卡片 -->
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <!-- 顶部渐变条 -->
        <div class="h-1 bg-gradient-to-r" :class="typeOptions.find(o => o.value === currentResult!.type)?.color || 'from-blue-500 to-indigo-500'"></div>

        <!-- 分析内容 -->
        <div class="p-5 space-y-3">
          <template v-for="(section, idx) in formattedAnalysis" :key="idx">
            <h3
              v-if="section.type === 'header'"
              class="text-sm font-semibold text-gray-800 mt-4 first:mt-0 flex items-start gap-1"
            >
              {{ section.content }}
            </h3>
            <div
              v-else-if="section.type === 'bullet'"
              class="flex items-start gap-2 text-sm text-gray-700 leading-relaxed pl-1"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0"></span>
              <span>{{ section.content }}</span>
            </div>
            <p
              v-else
              class="text-sm text-gray-700 leading-relaxed"
            >
              {{ section.content }}
            </p>
          </template>
        </div>

        <!-- 底部信息 -->
        <div class="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
          <span class="text-[10px] text-gray-400">生成于 {{ formatTime(currentResult.generated_at) }}</span>
          <button
            @click="showDataSummary = !showDataSummary"
            class="text-[11px] text-blue-500 hover:text-blue-600"
          >
            {{ showDataSummary ? '收起数据' : '查看原始数据' }}
          </button>
        </div>
      </div>

      <!-- 数据摘要（可折叠） -->
      <div v-if="showDataSummary" class="mt-3 bg-gray-50 rounded-xl border border-gray-100 p-4 space-y-3">
        <h4 class="text-xs font-medium text-gray-600">📈 分析依据数据</h4>

        <!-- 月度数据 -->
        <div>
          <div class="text-[10px] text-gray-500 mb-1">近期月度收支</div>
          <div class="space-y-1">
            <div
              v-for="m in currentResult.data_summary.months"
              :key="m.month"
              class="flex items-center justify-between text-xs"
            >
              <span class="text-gray-600">{{ m.month }}</span>
              <div class="flex gap-3">
                <span class="text-red-500">-¥{{ formatAmount(m.expense) }}</span>
                <span class="text-green-500">+¥{{ formatAmount(m.income) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 分类 -->
        <div v-if="currentResult.data_summary.categories.length > 0">
          <div class="text-[10px] text-gray-500 mb-1">本月支出分类</div>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="c in currentResult.data_summary.categories"
              :key="c.name"
              class="px-2 py-0.5 bg-white rounded text-[11px] text-gray-600 border border-gray-100"
            >
              {{ c.icon }} {{ c.name }} ¥{{ formatAmount(c.total) }}
            </span>
          </div>
        </div>

        <!-- 其他 -->
        <div class="flex gap-4 text-[11px] text-gray-500">
          <span>净资产: ¥{{ formatAmount(currentResult.data_summary.net_worth) }}</span>
          <span v-if="currentResult.data_summary.subscription_monthly > 0">
            订阅月费: ¥{{ formatAmount(currentResult.data_summary.subscription_monthly) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 初始空状态 -->
    <div v-if="!currentResult && !loading && !error" class="mt-12 text-center">
      <div class="text-4xl mb-3 opacity-50">🧠</div>
      <p class="text-sm text-gray-400">选择分析维度，点击开始</p>
      <p class="text-xs text-gray-300 mt-1">AI 将基于你的真实数据生成分析报告</p>
    </div>
  </div>
</template>
