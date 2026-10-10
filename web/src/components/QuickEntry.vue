<script setup lang="ts">
/**
 * 快速录入 · 全局记账动作
 *
 * 为什么记账不再是「一个页面」：
 * 记账是唯一的高频动作，但它原来要以「先跳到 / 页面」为前提。
 * 而人在看账本、看出纳时冒出的新账，恰恰是最容易忘掉的时刻——
 * 那时候的摩擦最大。所以把它变成一个动作：在哪都能 `⌘K` 弹出来，
 * 记完就地留在原页面。
 *
 * 三个要点：
 * 1. 草稿留得住：误按 Esc 不该丢句子（sessionStorage），下次打开还在。
 * 2. 失败就地降级：AI 没听懂时直接展开手动表单，不弹 Toast 打断。
 * 3. 记完立刻回读数：顶部仪表是常驻的，它不变就是在骗人。
 */
import { ref, computed, nextTick, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'
import { QUICK_DRAFT_KEY } from '@/composables/useQuickEntry'
import { useClusterStore } from '@/stores/cluster'
import { generateUUID } from '@/utils/uuid'
import BaseModal from './ui/BaseModal.vue'
import ConfirmCards from './ConfirmCards.vue'
import ManualForm from './ManualForm.vue'
import AppIcon from './ui/AppIcon.vue'
import Notice from './ui/Notice.vue'

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const cluster = useClusterStore()

const QUICK_PHRASES = ['午饭', '早饭', '咖啡', '打车', '地铁', '买菜', '晚饭', '零食']

const input = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const loading = ref(false)
const confirming = ref(false)
const error = ref('')
const parsedItems = ref<any[]>([])
const showManual = ref(false)

const canSubmit = computed(() => input.value.trim().length > 0 && !loading.value)

onMounted(() => {
  // 弹层每次都是新挂载，草稿得自己拿回来
  restoreDraft()
  nextTick(() => textarea.value?.focus())
})
// 注意：**不要**在 unmounted 时清草稿。弹层一关就删，等于每次误按 Esc
// 都把句子弄丢——而保留草稿正是这个设计的目的。
// 草稿在两处被清：成功入账后的 reset()，以及用户自己把输入框删空。
// sessionStorage 随标签页关闭自然消失，不需要额外清理。

function restoreDraft() {
  const d = sessionStorage.getItem(QUICK_DRAFT_KEY)
  if (d) { input.value = d; nextTick(autoGrow) }
}
function saveDraft() {
  if (input.value.trim()) sessionStorage.setItem(QUICK_DRAFT_KEY, input.value)
  else sessionStorage.removeItem(QUICK_DRAFT_KEY)
}

/** 文本域随内容长高，3–8 行 */
function autoGrow() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(Math.max(el.scrollHeight, 84), 200) + 'px'
}

function appendPhrase(phrase: string) {
  input.value = input.value.trim() ? `${input.value.trim()}，${phrase}` : phrase
  nextTick(autoGrow)
  textarea.value?.focus()
  saveDraft()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleParse()
  }
}

async function handleParse() {
  if (!canSubmit.value) return
  error.value = ''
  loading.value = true
  parsedItems.value = []
  try {
    const { data } = await api.post('/ai/parse', { input: input.value }, { timeout: 90000 })
    if (data.code === 0 && data.data.items.length > 0) {
      parsedItems.value = data.data.items
    } else {
      failToManual(data.message || 'AI 没听出账目')
    }
  } catch (e: any) {
    failToManual(e.response?.data?.message || 'AI 请求失败')
  } finally {
    loading.value = false
  }
}

/** AI 失败不是终点：就地降级到手动，而不是弹个 Toast 让人干瞪眼 */
function failToManual(msg: string) {
  error.value = `${msg}，已切到手动记账`
  showManual.value = true
}

function reset() {
  parsedItems.value = []
  input.value = ''
  error.value = ''
  showManual.value = false
  sessionStorage.removeItem(QUICK_DRAFT_KEY)
  nextTick(() => textarea.value && (textarea.value.style.height = '84px'))
}

async function handleConfirm(items: any[]) {
  if (confirming.value) return
  confirming.value = true
  try {
    await api.post('/transactions', {
      items: items.map(item => ({
        client_id: generateUUID(),
        client_type: 'web',
        source: 'ai',
        type: item.type,
        amount: item.amount,
        category_id: item.category_id,
        account_id: item.account_id || undefined,
        target_account_id: item.target_account_id || undefined,
        description: item.description,
        date: item.date,
        tags: item.tags || undefined,
      })),
    })
    reset()
    toast.success(`已记 ${items.length} 笔`)
    cluster.load(true) // 顶部读数必须立刻跟上
    // 弹层不关：连着记第二笔（早歺/咖啡/地铁）是常见用法，
    // 但焦点必须回到输入框，否则用户得再点一次才能接着打。
    nextTick(() => textarea.value?.focus())
    emit('saved')
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  } finally {
    confirming.value = false
  }
}

async function handleManual(item: any) {
  try {
    await api.post('/transactions', {
      items: [{
        client_id: generateUUID(),
        client_type: 'web',
        source: 'manual',
        type: item.type,
        amount: item.amount,
        category_id: item.category_id,
        account_id: item.account_id || undefined,
        target_account_id: item.target_account_id || undefined,
        description: item.description,
        date: item.date,
        tags: item.tags || undefined,
      }],
    })
    reset()
    toast.success('记账成功')
    cluster.load(true)
    emit('saved')
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  }
}

defineExpose({ restoreDraft })
</script>

<template>
  <BaseModal
    :show="true"
    size="lg"
    :dismissible="true"
    @close="emit('close')"
  >
    <template #header>
      <div class="qe-head">
        <h2 class="qe-title">记一笔</h2>
        <span class="qe-hint">
          <kbd>⌘</kbd><kbd>K</kbd> 打开 · <kbd>↵</kbd> 解析
        </span>
      </div>
    </template>

    <!-- 解析结果出来之前：只有输入区 -->
    <template v-if="!parsedItems.length && !showManual">
      <div class="qe-composer">
        <textarea
          ref="textarea"
          v-model="input"
          rows="3"
          class="qe-textarea"
          placeholder="午饭 32，打车 15"
          :disabled="loading"
          @input="autoGrow(); saveDraft()"
          @keydown="onKeydown"
        />
        <div class="qe-actions">
          <button class="btn btn-primary" :disabled="!canSubmit" @click="handleParse">
            <span
              v-if="loading"
              class="qe-spinner"
            />
            <AppIcon v-else name="spark" :size="14" />
            {{ loading ? 'AI 正在拆解…' : '解析' }}
          </button>
          <button class="btn btn-outline" @click="showManual = true; error = ''">手动</button>
          <span v-if="!loading" class="qe-count amt">{{ input.length }} 字</span>
        </div>
      </div>

      <div v-if="error" class="mt-3">
        <Notice tone="danger">{{ error }}</Notice>
      </div>

      <div class="scroll-x qe-phrases">
        <button
          v-for="p in QUICK_PHRASES"
          :key="p"
          type="button"
          class="chip shrink-0"
          @click="appendPhrase(p)"
        >{{ p }}</button>
      </div>
    </template>

    <!-- 解析结果：确认卡片接管 -->
    <ConfirmCards
      v-else-if="parsedItems.length"
      :items="parsedItems"
      @confirm="handleConfirm"
      @cancel="reset()"
    />

    <!-- 手动兜底 -->
    <ManualForm
      v-else
      :initial-description="input"
      @submit="handleManual"
      @cancel="reset()"
    />
  </BaseModal>
</template>

<style scoped>
.qe-head { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
.qe-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--color-ink-1);
}
/* 快捷键提示只在有物理键盘的地方出现——手机上显示 ⌘K 是噪声 */
.qe-hint {
  display: none;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.625rem;
  color: var(--color-ink-4);
  white-space: nowrap;
}
@media (min-width: 768px) { .qe-hint { display: inline-flex; } }
.qe-hint kbd {
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  padding: 0.0625rem 0.25rem;
  line-height: 1.3;
  background: var(--color-paper-sunk);
}

.qe-composer { position: relative; }
.qe-textarea {
  width: 100%;
  min-height: 5.25rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-sm);
  /* 输入区左缘一道反相色条：这是「现在要做的事」，不是内容 */
  box-shadow: inset 3px 0 0 var(--color-inverse);
  background: var(--color-paper-raised);
  color: var(--color-ink-1);
  font-family: inherit;
  font-size: 1rem;
  line-height: 1.55;
  resize: none;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.qe-textarea::placeholder {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
}
.qe-textarea:focus,
.qe-textarea:focus-visible {
  outline: none;
  border-color: var(--color-ink-1);
  box-shadow: inset 3px 0 0 var(--color-inverse), 0 0 0 3px color-mix(in srgb, var(--color-action) 14%, transparent);
}
.qe-textarea:disabled { background: var(--color-paper-sunk); color: var(--color-ink-4); }

.qe-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.qe-count { margin-left: auto; font-size: 0.625rem; color: var(--color-ink-4); }

.qe-spinner {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--color-action-fg) 30%, transparent);
  border-top-color: var(--color-action-fg);
  animation: qe-spin 0.7s linear infinite;
}
@keyframes qe-spin { to { transform: rotate(360deg); } }

.qe-phrases { display: flex; gap: 0.375rem; margin-top: 0.75rem; padding-bottom: 0.125rem; }
</style>
