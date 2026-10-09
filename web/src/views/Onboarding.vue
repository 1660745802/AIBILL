<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'
import { generateUUID } from '@/utils/uuid'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import Notice from '@/components/ui/Notice.vue'
import EmptyState from '@/components/ui/EmptyState.vue'

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

</script>

<template>
  <div class="onb">
    <!-- 步骤条 -->
    <header class="onb-head">
      <div class="steps w-40">
        <span
          v-for="i in totalSteps"
          :key="i"
          :class="step > i ? 'done' : step === i ? 'current' : ''"
        />
      </div>
      <span class="text-[0.6875rem] amt shrink-0" style="color: var(--color-ink-3)">
        {{ step }} / {{ totalSteps }}
      </span>
      <button class="act ml-1" @click="skip">
        {{ step === totalSteps ? '完成' : '跳过' }}
      </button>
    </header>

    <!-- 步骤 1 · 欢迎 -->
    <section v-if="step === 1" class="onb-body onb-center">
      <span class="onb-mark" aria-hidden="true">账</span>
      <h1 class="text-2xl font-semibold mt-5" style="color: var(--color-ink-1)">
        欢迎使用财务工作台
      </h1>
      <p class="text-sm mt-2 max-w-xs leading-relaxed" style="color: var(--color-ink-2)">
        说一句话就能记账。剩下的交给 AI。
      </p>
      <p class="text-xs mt-1.5" style="color: var(--color-ink-3)">设置大概 30 秒，随时可以改。</p>

      <button class="btn btn-primary btn-lg w-full max-w-xs mt-8" @click="nextStep">
        开始设置
      </button>

      <dl class="mt-10 grid grid-cols-3 gap-4 w-full max-w-xs pt-6"
          style="border-top: 1px solid var(--color-rule)">
        <div v-for="c in [
          { icon: 'spark', t: '一句话记账' },
          { icon: 'chart', t: '自动统计' },
          { icon: 'shield', t: '数据私有' },
        ]" :key="c.t" class="text-center">
          <AppIcon :name="c.icon" :size="18" class="mx-auto mb-1.5" style="color: var(--color-ink-3)" />
          <dt class="text-[0.6875rem]" style="color: var(--color-ink-3)">{{ c.t }}</dt>
        </div>
      </dl>
    </section>

    <!-- 步骤 2 · 选账户 -->
    <section v-else-if="step === 2" class="onb-body">
      <div class="onb-title">
        <AppIcon name="wallet" :size="20" class="mx-auto mb-3" style="color: var(--color-ink-3)" />
        <h2>选你常用的账户</h2>
        <p>记账时会默认用它，少选一步</p>
      </div>

      <div class="w-full max-w-sm space-y-2">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="pick-row"
          :class="{ 'pick-row-on': selectedAccountIds.includes(acc.id) }"
          role="checkbox"
          :aria-checked="selectedAccountIds.includes(acc.id)"
          tabindex="0"
          @click="toggleAccount(acc.id)"
          @keydown.enter.space.prevent="toggleAccount(acc.id)"
        >
          <span class="tx-icon" aria-hidden="true">{{ acc.icon }}</span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm truncate" style="color: var(--color-ink-1)">{{ acc.name }}</span>
          </span>
          <span class="badge shrink-0">余额 {{ (acc.balance / 100).toFixed(0) }}</span>
          <button
            v-if="selectedAccountIds.includes(acc.id)"
            class="chip shrink-0"
            :class="{ 'chip-active': defaultAccountId === acc.id }"
            @click.stop="setDefault(acc.id)"
          >{{ defaultAccountId === acc.id ? '默认' : '设为默认' }}</button>
          <span class="pick-tick" aria-hidden="true">
            <AppIcon name="check" :size="12" :stroke="2.6" />
          </span>
        </div>

        <EmptyState v-if="!accounts.length" compact icon="wallet" title="还没有账户"
                    description="可以先去设置里创建，或直接跳过这步" />
      </div>

      <button class="btn btn-primary btn-block w-full max-w-sm" @click="confirmStep2">
        继续<template v-if="selectedAccountIds.length">（已选 {{ selectedAccountIds.length }} 个）</template>
      </button>
    </section>

    <!-- 步骤 3 · 设余额 -->
    <section v-else-if="step === 3" class="onb-body">
      <div class="onb-title">
        <AppIcon name="gauge" :size="20" class="mx-auto mb-3" style="color: var(--color-ink-3)" />
        <h2>填一下当前余额</h2>
        <p>不确定可以留空，之后随时能改</p>
      </div>

      <div class="w-full max-w-sm">
        <EmptyState
          v-if="!selectedAccountIds.length"
          compact
          icon="inbox"
          title="还没有选择账户"
          description="回到上一步勾选至少一个账户"
        />

        <div v-else class="sheet">
          <div
            v-for="acc in accounts.filter(a => selectedAccountIds.includes(a.id))"
            :key="acc.id"
            class="sheet-row"
          >
            <span class="tx-icon" aria-hidden="true">{{ acc.icon }}</span>
            <span class="text-sm flex-1 min-w-0 truncate" style="color: var(--color-ink-1)">{{ acc.name }}</span>
            <span class="relative w-28">
              <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                    style="color: var(--color-ink-4)">¥</span>
              <input
                v-model="balances[acc.id]"
                type="number"
                step="0.01"
                inputmode="decimal"
                class="field !h-8 !pl-6 !text-right amt"
                placeholder="0.00"
              />
            </span>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block w-full max-w-sm" @click="confirmStep3">继续</button>
    </section>

    <!-- 步骤 4 · 试记一笔 -->
    <section v-else-if="step === 4" class="onb-body">
      <template v-if="!trialSuccess">
        <div class="onb-title">
          <AppIcon name="spark" :size="20" class="mx-auto mb-3" style="color: var(--color-ink-3)" />
          <h2>试记一笔</h2>
          <p>用平时说话的方式输入，AI 会拆好</p>
        </div>

        <div class="w-full max-w-sm">
          <input
            v-model="trialInput"
            type="text"
            class="field !h-12 !text-base"
            placeholder="早餐8，咖啡18，地铁4"
            @keyup.enter="trialParse"
          />

          <ul v-if="!trialParsed" class="grid grid-cols-2 gap-2 mt-3">
            <li v-for="ex in examplePhrases" :key="ex.text">
              <button class="w-full text-left surface px-3 py-2.5 hover:bg-paper-hover transition-colors"
                      @click="useExample(ex.text)">
                <span class="block text-[0.8125rem] truncate" style="color: var(--color-ink-1)">{{ ex.text }}</span>
                <span class="block text-[0.6875rem] mt-0.5" style="color: var(--color-ink-3)">{{ ex.desc }}</span>
              </button>
            </li>
          </ul>

          <button
            v-if="!trialParsed"
            class="btn btn-primary btn-block mt-3"
            :disabled="trialLoading || !trialInput.trim()"
            @click="trialParse"
          >
            <span v-if="trialLoading"
                  class="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            <AppIcon v-else name="spark" :size="14" />
            {{ trialLoading ? 'AI 正在拆解…' : '让 AI 解析' }}
          </button>

          <template v-if="trialParsed">
            <LedgerLabel class="mt-5">AI 为你拆出</LedgerLabel>
            <ul class="sheet">
              <li v-for="(item, idx) in trialParsed" :key="idx" class="sheet-row">
                <span class="tx-icon" aria-hidden="true">{{ item.category_icon || '📦' }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[0.8125rem] truncate" style="color: var(--color-ink-1)">
                    {{ item.description || item.category_name }}
                  </span>
                  <span class="block text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
                    {{ item.category_name || item.type }} · {{ item.date }}
                  </span>
                </span>
                <Money :value="item.amount" :tone="item.type === 'income' ? 'income' : 'expense'" />
              </li>
            </ul>
            <div class="flex gap-2 mt-3">
              <button class="btn btn-outline flex-1" @click="trialParsed = null; trialInput = ''">换个说法</button>
              <button class="btn btn-primary flex-[2]" :disabled="trialLoading" @click="confirmTrial">
                {{ trialLoading ? '记录中…' : '确认入账' }}
              </button>
            </div>
          </template>

          <Notice v-if="trialError" tone="danger" class="mt-3">{{ trialError }}</Notice>

          <p v-if="!trialParsed" class="text-center text-[0.6875rem] mt-4" style="color: var(--color-ink-4)">
            也可以直接跳过，回首页再试
          </p>
        </div>
      </template>

      <!-- 成功 -->
      <div v-else class="onb-center w-full max-w-sm">
        <span class="onb-tick" aria-hidden="true">
          <AppIcon name="check" :size="30" :stroke="2.4" />
        </span>
        <h2 class="text-xl font-semibold mt-5" style="color: var(--color-ink-1)">记好了</h2>
        <p class="text-sm mt-2" style="color: var(--color-ink-2)">这笔已经进账，往后照这个方式记就行。</p>
        <button class="btn btn-primary btn-lg w-full mt-8" @click="finish">开始使用</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.onb {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--color-paper);
}
.onb-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1.25rem;
  border-bottom: 3px double var(--color-rule-strong);
}
.onb-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  padding: 2rem 1.25rem 3rem;
}
.onb-center { justify-content: center; }
.onb-title { text-align: center; }
.onb-title h2 {
  font-size: 1.125rem;
  font-weight: 650;
  color: var(--color-ink-1);
}
.onb-title p { font-size: 0.8125rem; color: var(--color-ink-3); margin-top: 0.25rem; }

.onb-mark {
  width: 4rem;
  height: 4rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-action);
  color: var(--color-action-fg);
  font-size: 1.75rem;
  font-weight: 700;
}
.onb-tick {
  width: 4.5rem;
  height: 4.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-income-soft);
  border: 1px solid var(--color-income-line);
  color: var(--color-income);
}

/* 可勾选行：墨色边框 + 右上角勾，不用蓝色填充 */
.pick-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper-raised);
  cursor: pointer;
  transition: border-color 0.14s ease, background-color 0.14s ease;
}
.pick-row:hover { border-color: var(--color-ink-4); }
.pick-row-on { border-color: var(--color-ink-1); }
.pick-tick {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-xs);
  color: transparent;
}
.pick-row-on .pick-tick {
  background: var(--color-action);
  border-color: var(--color-action);
  color: var(--color-action-fg);
}
</style>
