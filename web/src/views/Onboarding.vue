<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'

const router = useRouter()

const step = ref(1)

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

onMounted(async () => {
  try {
    const { data } = await api.get('/accounts')
    if (data.code === 0) {
      accounts.value = data.data.items || data.data || []
    }
  } catch { /* ignore */ }
})

function nextStep() {
  if (step.value < 4) {
    step.value++
  }
}

function skip() {
  if (step.value < 4) {
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
      await api.put('/settings', { default_account_id: defaultAccountId.value })
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
      trialError.value = data.message || '解析失败，请重试'
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
    const { data } = await api.post('/transactions', { items: trialParsed.value })
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
  <div class="min-h-screen bg-gray-50 flex flex-col">
    <!-- 顶部跳过按钮 -->
    <div class="flex justify-end p-4">
      <button
        @click="skip"
        class="text-sm text-gray-400 hover:text-gray-600"
      >
        跳过
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 flex flex-col items-center justify-center px-6 pb-20">
      <!-- Step 1: 欢迎页 -->
      <div v-if="step === 1" class="text-center max-w-sm">
        <div class="text-5xl mb-6">💰</div>
        <h1 class="text-2xl font-bold text-gray-900 mb-3">欢迎使用 AI 记账</h1>
        <p class="text-gray-500 mb-8">说句话就能记账，轻松管理个人财务</p>
        <button
          @click="nextStep"
          class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          开始设置
        </button>
      </div>

      <!-- Step 2: 选择常用账户 -->
      <div v-else-if="step === 2" class="w-full max-w-sm">
        <h2 class="text-xl font-bold text-gray-900 mb-2 text-center">选择常用账户</h2>
        <p class="text-sm text-gray-500 mb-6 text-center">勾选你日常使用的账户，并设置一个默认账户</p>

        <div class="space-y-2 mb-6">
          <div
            v-for="acc in accounts"
            :key="acc.id"
            class="flex items-center justify-between p-3 bg-white rounded-lg border"
            :class="selectedAccountIds.includes(acc.id) ? 'border-blue-300 bg-blue-50' : 'border-gray-200'"
          >
            <label class="flex items-center gap-3 cursor-pointer flex-1">
              <input
                type="checkbox"
                :checked="selectedAccountIds.includes(acc.id)"
                @change="toggleAccount(acc.id)"
                class="w-4 h-4 text-blue-600 rounded"
              />
              <span class="text-lg">{{ acc.icon }}</span>
              <span class="text-sm text-gray-800">{{ acc.name }}</span>
            </label>
            <button
              v-if="selectedAccountIds.includes(acc.id)"
              @click="setDefault(acc.id)"
              class="text-xs px-2 py-0.5 rounded"
              :class="defaultAccountId === acc.id ? 'bg-blue-600 text-white' : 'text-blue-500 border border-blue-300'"
            >
              {{ defaultAccountId === acc.id ? '默认' : '设为默认' }}
            </button>
          </div>
        </div>

        <button
          @click="confirmStep2"
          class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          下一步
        </button>
      </div>

      <!-- Step 3: 设置初始余额 -->
      <div v-else-if="step === 3" class="w-full max-w-sm">
        <h2 class="text-xl font-bold text-gray-900 mb-2 text-center">设置初始余额</h2>
        <p class="text-sm text-gray-500 mb-6 text-center">可选填，方便后续对账</p>

        <div class="space-y-3 mb-6">
          <div
            v-for="acc in accounts.filter(a => selectedAccountIds.includes(a.id))"
            :key="acc.id"
            class="flex items-center gap-3 bg-white p-3 rounded-lg border border-gray-200"
          >
            <span class="text-lg">{{ acc.icon }}</span>
            <span class="text-sm text-gray-700 min-w-16">{{ acc.name }}</span>
            <div class="flex-1 relative">
              <span class="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
              <input
                v-model="balances[acc.id]"
                type="number"
                step="0.01"
                placeholder="0.00"
                class="w-full pl-6 pr-2 py-1.5 border border-gray-300 rounded text-sm text-right"
              />
            </div>
          </div>
          <p v-if="selectedAccountIds.length === 0" class="text-center text-sm text-gray-400">
            未选择任何账户，可跳过此步
          </p>
        </div>

        <button
          @click="confirmStep3"
          class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          下一步
        </button>
      </div>

      <!-- Step 4: 试记一笔 -->
      <div v-else-if="step === 4" class="w-full max-w-sm">
        <div v-if="!trialSuccess">
          <h2 class="text-xl font-bold text-gray-900 mb-2 text-center">试记一笔</h2>
          <p class="text-sm text-gray-500 mb-6 text-center">用自然语言输入一笔消费试试</p>

          <div class="mb-4">
            <input
              v-model="trialInput"
              type="text"
              placeholder="例如：午饭 32 元"
              class="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keyup.enter="trialParse"
            />
          </div>

          <button
            v-if="!trialParsed"
            @click="trialParse"
            :disabled="trialLoading || !trialInput.trim()"
            class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
          >
            {{ trialLoading ? '解析中...' : 'AI 解析' }}
          </button>

          <!-- 解析结果预览 -->
          <div v-if="trialParsed" class="mt-4 space-y-2">
            <div
              v-for="(item, idx) in trialParsed"
              :key="idx"
              class="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200"
            >
              <div class="flex items-center gap-2">
                <span class="text-lg">{{ item.category_icon || '📦' }}</span>
                <div>
                  <div class="text-sm font-medium text-gray-800">{{ item.description }}</div>
                  <div class="text-xs text-gray-400">{{ item.category_name }}</div>
                </div>
              </div>
              <div class="text-sm font-semibold text-gray-800">
                ¥{{ formatAmount(item.amount) }}
              </div>
            </div>

            <div class="flex gap-3 mt-4">
              <button
                @click="confirmTrial"
                :disabled="trialLoading"
                class="flex-1 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
              >
                {{ trialLoading ? '记录中...' : '确认记账' }}
              </button>
              <button
                @click="trialParsed = null"
                class="px-4 py-3 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                重新输入
              </button>
            </div>
          </div>

          <div v-if="trialError" class="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
            {{ trialError }}
          </div>
        </div>

        <!-- 试记成功 -->
        <div v-else class="text-center">
          <div class="text-5xl mb-4">🎉</div>
          <h2 class="text-xl font-bold text-gray-900 mb-2">太好了！</h2>
          <p class="text-sm text-gray-500 mb-8">你已经学会使用 AI 记账了</p>
          <button
            @click="finish"
            class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            开始使用
          </button>
        </div>
      </div>
    </div>

    <!-- 底部进度指示器 -->
    <div class="fixed bottom-6 left-0 right-0 flex justify-center gap-2">
      <span
        v-for="i in 4"
        :key="i"
        class="w-2 h-2 rounded-full transition-colors"
        :class="i === step ? 'bg-blue-600' : 'bg-gray-300'"
      ></span>
    </div>
  </div>
</template>
