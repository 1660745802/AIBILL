<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'
import { generateUUID } from '@/utils/uuid'

const router = useRouter()

const step = ref(1)
const totalSteps = 4

// Step 2: 账户选择
interface Account {
  id: number
  name: string
  icon: string
  balance: number
}

const accounts = ref<Account[]>([])
const selectedAccountIds = ref<number[]>([])
const defaultAccountId = ref<number | null>(null)

// Step 3: 余额设置
const balances = ref<Record<number, string>>({})

// Step 4: 试记一笔
const trialInput = ref('')
const trialLoading = ref(false)
const trialParsed = ref<any[] | null>(null)
const trialSuccess = ref(false)
const trialError = ref('')

// 示范短语（让新用户一键体验）
const examplePhrases = [
  { text: '午饭 32', desc: '最简单的记账' },
  { text: '打车 15 支付宝', desc: '指定账户' },
  { text: '早餐8，咖啡18，地铁4', desc: '一次记多笔' },
  { text: '发工资 12000', desc: '记一笔收入' },
]

const progressPercent = computed(() => ((step.value - 1) / (totalSteps - 1)) * 100)

onMounted(async () => {
  try {
    const { data } = await api.get('/accounts')
    if (data.code === 0) {
      accounts.value = data.data.items || data.data || []
      // 默认全选
      selectedAccountIds.value = accounts.value.map(a => a.id)
      // 默认选第一个
      if (accounts.value.length > 0) {
        defaultAccountId.value = accounts.value[0]!.id
      }
    }
  } catch { /* ignore */ }
})

function nextStep() {
  if (step.value < totalSteps) {
    step.value++
  }
}

function skip() {
  if (step.value < totalSteps) {
    step.value++
  } else {
    finish()
  }
}

function toggleAccount(id: number) {
  const idx = selectedAccountIds.value.indexOf(id)
  if (idx >= 0) {
    selectedAccountIds.value.splice(idx, 1)
    if (defaultAccountId.value === id) {
      defaultAccountId.value = null
    }
  } else {
    selectedAccountIds.value.push(id)
  }
}

function setDefault(id: number) {
  defaultAccountId.value = id
}

async function confirmStep2() {
  if (defaultAccountId.value) {
    try {
      await api.put('/settings', { default_account_id: String(defaultAccountId.value) })
    } catch { /* ignore */ }
  }
  nextStep()
}

async function confirmStep3() {
  const updates: Promise<any>[] = []
  for (const id of selectedAccountIds.value) {
    const val = balances.value[id]
    if (val && parseFloat(val) !== 0) {
      const cents = Math.round(parseFloat(val) * 100)
      updates.push(api.put(`/accounts/${id}`, { balance: cents }))
    }
  }
  if (updates.length > 0) {
    try {
      await Promise.all(updates)
    } catch { /* ignore */ }
  }
  nextStep()
}

function useExample(text: string) {
  trialInput.value = text
}

async function trialParse() {
  if (!trialInput.value.trim()) return
  trialLoading.value = true
  trialError.value = ''
  trialParsed.value = null
  try {
    const { data } = await api.post('/ai/parse', { input: trialInput.value }, { timeout: 90000 })
    if (data.code === 0 && data.data?.items?.length) {
      trialParsed.value = data.data.items
    } else {
      trialError.value = data.message || '解析失败，换个说法试试？'
    }
  } catch {
    trialError.value = '网络错误，请重试'
  } finally {
    trialLoading.value = false
  }
}

async function confirmTrial() {
  if (!trialParsed.value) return
  trialLoading.value = true
  try {
    const payload = trialParsed.value.map((item: any) => ({
      ...item,
      client_id: generateUUID(),
      client_type: 'web',
      source: 'ai',
      source_detail: trialInput.value,
    }))
    const { data } = await api.post('/transactions', { items: payload })
    if (data.code === 0) {
      trialSuccess.value = true
    } else {
      trialError.value = data.message || '记账失败'
    }
  } catch {
    trialError.value = '网络错误，请重试'
  } finally {
    trialLoading.value = false
  }
}

function finish() {
  router.push('/')
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <div class="min-h-screen bg-gradient-to-b from-blue-50 via-white to-gray-50 flex flex-col">
    <!-- 顶部栏 -->
    <div class="flex items-center justify-between px-5 pt-5 pb-2">
      <!-- 进度条 -->
      <div class="flex-1 max-w-48">
        <div class="h-1 bg-gray-200 rounded-full overflow-hidden">
          <div
            class="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-500 ease-out"
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <div class="text-[10px] text-gray-400 mt-1">{{ step }} / {{ totalSteps }}</div>
      </div>
      <button
        @click="skip"
        class="text-sm text-gray-400 hover:text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-100 transition-colors"
      >
        {{ step === totalSteps ? '完成' : '跳过' }}
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 flex flex-col items-center justify-center px-6 pb-24">
      <!-- Step 1: 欢迎页 -->
      <div v-if="step === 1" class="text-center max-w-sm w-full">
        <div class="w-24 h-24 mx-auto mb-6 bg-gradient-to-br from-blue-400 to-blue-600 rounded-3xl flex items-center justify-center shadow-lg shadow-blue-200">
          <span class="text-4xl">💰</span>
        </div>
        <h1 class="text-2xl font-bold text-gray-900 mb-2">欢迎使用 AI 记账</h1>
        <p class="text-gray-500 mb-2">说句话就能记账，轻松管理个人财务</p>
        <p class="text-sm text-gray-400 mb-8">只需 30 秒完成设置</p>

        <div class="space-y-3">
          <button
            @click="nextStep"
            class="w-full py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200 hover:shadow-lg transition-shadow"
          >
            开始设置 →
          </button>
        </div>

        <!-- 亮点 -->
        <div class="mt-10 grid grid-cols-3 gap-4 text-center">
          <div>
            <div class="text-2xl mb-1">🎙️</div>
            <div class="text-[11px] text-gray-500">自然语言记账</div>
          </div>
          <div>
            <div class="text-2xl mb-1">📊</div>
            <div class="text-[11px] text-gray-500">智能统计分析</div>
          </div>
          <div>
            <div class="text-2xl mb-1">🔒</div>
            <div class="text-[11px] text-gray-500">数据完全私有</div>
          </div>
        </div>
      </div>

      <!-- Step 2: 选择常用账户 -->
      <div v-else-if="step === 2" class="w-full max-w-sm">
        <div class="text-center mb-6">
          <div class="w-14 h-14 mx-auto mb-3 bg-green-100 rounded-2xl flex items-center justify-center">
            <span class="text-2xl">💳</span>
          </div>
          <h2 class="text-xl font-bold text-gray-900 mb-1">选择常用账户</h2>
          <p class="text-sm text-gray-500">选一个默认账户，记账时可以少选一步</p>
        </div>

        <div class="space-y-2 mb-6">
          <div
            v-for="acc in accounts"
            :key="acc.id"
            @click="toggleAccount(acc.id)"
            class="flex items-center justify-between p-3.5 bg-white rounded-xl border-2 cursor-pointer transition-all"
            :class="selectedAccountIds.includes(acc.id) ? 'border-blue-400 shadow-sm' : 'border-gray-100 hover:border-gray-200'"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-9 h-9 rounded-lg flex items-center justify-center text-lg"
                :class="selectedAccountIds.includes(acc.id) ? 'bg-blue-50' : 'bg-gray-50'"
              >{{ acc.icon }}</div>
              <span class="text-sm font-medium text-gray-800">{{ acc.name }}</span>
            </div>
            <button
              v-if="selectedAccountIds.includes(acc.id)"
              @click.stop="setDefault(acc.id)"
              class="text-xs px-2.5 py-1 rounded-full font-medium transition-colors"
              :class="defaultAccountId === acc.id ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600'"
            >
              {{ defaultAccountId === acc.id ? '✓ 默认' : '设为默认' }}
            </button>
          </div>
        </div>

        <button
          @click="confirmStep2"
          class="w-full py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200"
        >
          继续
        </button>
      </div>

      <!-- Step 3: 设置初始余额 -->
      <div v-else-if="step === 3" class="w-full max-w-sm">
        <div class="text-center mb-6">
          <div class="w-14 h-14 mx-auto mb-3 bg-purple-100 rounded-2xl flex items-center justify-center">
            <span class="text-2xl">💵</span>
          </div>
          <h2 class="text-xl font-bold text-gray-900 mb-1">设置初始余额</h2>
          <p class="text-sm text-gray-500">不确定可以跳过，之后随时修改</p>
        </div>

        <div class="space-y-2.5 mb-6">
          <div
            v-for="acc in accounts.filter(a => selectedAccountIds.includes(a.id))"
            :key="acc.id"
            class="flex items-center gap-3 bg-white p-3.5 rounded-xl border border-gray-100"
          >
            <div class="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center text-lg shrink-0">{{ acc.icon }}</div>
            <span class="text-sm text-gray-700 min-w-14 shrink-0">{{ acc.name }}</span>
            <div class="flex-1 relative">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
              <input
                v-model="balances[acc.id]"
                type="number"
                step="0.01"
                placeholder="0.00"
                class="w-full pl-7 pr-3 py-2 border border-gray-200 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              />
            </div>
          </div>
          <p v-if="selectedAccountIds.length === 0" class="text-center text-sm text-gray-400 py-4">
            没有选中的账户
          </p>
        </div>

        <button
          @click="confirmStep3"
          class="w-full py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200"
        >
          继续
        </button>
      </div>

      <!-- Step 4: 试记一笔 -->
      <div v-else-if="step === 4" class="w-full max-w-sm">
        <div v-if="!trialSuccess">
          <div class="text-center mb-5">
            <div class="w-14 h-14 mx-auto mb-3 bg-amber-100 rounded-2xl flex items-center justify-center">
              <span class="text-2xl">✨</span>
            </div>
            <h2 class="text-xl font-bold text-gray-900 mb-1">试试 AI 记账</h2>
            <p class="text-sm text-gray-500">用日常说话的方式输入，AI 帮你解析</p>
          </div>

          <!-- 输入框 -->
          <div class="relative mb-3">
            <input
              v-model="trialInput"
              type="text"
              placeholder="试试输入一笔..."
              class="w-full px-4 py-3.5 bg-white border-2 border-gray-100 rounded-xl text-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50 transition-all"
              @keyup.enter="trialParse"
            />
          </div>

          <!-- 示范短语（点击填入） -->
          <div v-if="!trialParsed" class="mb-5">
            <div class="text-[11px] text-gray-400 mb-2">💡 点击试试：</div>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="ex in examplePhrases"
                :key="ex.text"
                @click="useExample(ex.text)"
                class="text-left px-3 py-2.5 bg-white border border-gray-100 rounded-xl hover:border-blue-200 hover:bg-blue-50 transition-all group"
              >
                <div class="text-sm text-gray-700 group-hover:text-blue-700 font-medium">{{ ex.text }}</div>
                <div class="text-[10px] text-gray-400 mt-0.5">{{ ex.desc }}</div>
              </button>
            </div>
          </div>

          <!-- 解析按钮 -->
          <button
            v-if="!trialParsed"
            @click="trialParse"
            :disabled="trialLoading || !trialInput.trim()"
            class="w-full py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
          >
            <span v-if="trialLoading" class="inline-flex items-center gap-2">
              <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
              AI 解析中...
            </span>
            <span v-else>🤖 AI 解析</span>
          </button>

          <!-- 解析结果 -->
          <div v-if="trialParsed" class="space-y-2 mb-4">
            <div class="text-[11px] text-gray-400 mb-1">AI 为你解析出：</div>
            <div
              v-for="(item, idx) in trialParsed"
              :key="idx"
              class="flex items-center justify-between p-3.5 bg-white rounded-xl border border-gray-100"
            >
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center text-lg">{{ item.category_icon || '📦' }}</div>
                <div>
                  <div class="text-sm font-medium text-gray-800">{{ item.description }}</div>
                  <div class="text-[11px] text-gray-400">{{ item.category_name || item.type }} · {{ item.date }}</div>
                </div>
              </div>
              <div class="text-base font-semibold" :class="item.type === 'income' ? 'text-green-600' : 'text-gray-800'">
                {{ item.type === 'income' ? '+' : '-' }}¥{{ formatAmount(item.amount) }}
              </div>
            </div>

            <div class="flex gap-2.5 mt-4">
              <button
                @click="confirmTrial"
                :disabled="trialLoading"
                class="flex-1 py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200 disabled:opacity-50"
              >
                {{ trialLoading ? '记录中...' : '✓ 确认记账' }}
              </button>
              <button
                @click="trialParsed = null; trialInput = ''"
                class="px-4 py-3.5 text-sm text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 font-medium"
              >
                重试
              </button>
            </div>
          </div>

          <div v-if="trialError" class="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 p-3 rounded-xl">
            {{ trialError }}
          </div>

          <!-- 跳过提示 -->
          <p v-if="!trialParsed" class="text-center text-[11px] text-gray-400 mt-4">
            也可以直接跳过，回首页再试
          </p>
        </div>

        <!-- 试记成功 🎉 -->
        <div v-else class="text-center">
          <div class="w-20 h-20 mx-auto mb-5 bg-gradient-to-br from-green-400 to-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-green-200">
            <span class="text-3xl">🎉</span>
          </div>
          <h2 class="text-2xl font-bold text-gray-900 mb-2">记账成功！</h2>
          <p class="text-gray-500 mb-2">你已经学会使用 AI 记账了</p>
          <p class="text-sm text-gray-400 mb-8">以后只需说句话，AI 帮你搞定一切</p>
          <button
            @click="finish"
            class="w-full py-3.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl font-medium shadow-md shadow-blue-200"
          >
            开始使用 🚀
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
