<script setup lang="ts">
/**
 * 记账：把一句话交给 AI，解析出**一笔**账（取消批量记账：一次解析 = 一笔）。
 * 这是整个产品唯一"用力"的地方——它是主动作，也是差异点。
 */
import { ref, onMounted, computed, nextTick, watch } from 'vue'
import api from '@/api/index'
import { today } from '@/utils/date'
import { useToast } from '@/composables/useToast'
import { useClusterStore } from '@/stores/cluster'
import { useQuickEntry } from '@/composables/useQuickEntry'
import { generateUUID } from '@/utils/uuid'
import ConfirmCards from '@/components/ConfirmCards.vue'
import ManualForm from '@/components/ManualForm.vue'
import EditTransactionModal from '@/components/EditTransactionModal.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import Notice from '@/components/ui/Notice.vue'
import SheetRow from '@/components/ui/SheetRow.vue'
import EmptyState from '@/components/ui/EmptyState.vue'

const toast = useToast()
const quick = useQuickEntry()

const input = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const loading = ref(false)
const confirming = ref(false)
const error = ref('')
const parsedItems = ref<any[]>([])
const showManual = ref(false)
const todayTransactions = ref<any[]>([])
const editing = ref<any | null>(null)

type Submission = { signature: string; clientId: string }
let aiSubmissions: Submission[] = []
let manualSubmissions: Submission[] = []

// 同一内容重试复用 ID；逐行消耗避免两笔相同内容误用同一个 ID。
function identifyItems(items: Record<string, unknown>[], previous: Submission[]) {
  const available = [...previous]
  previous.length = 0
  return items.map((item) => {
    const signature = JSON.stringify(item)
    const index = available.findIndex((entry) => entry.signature === signature)
    const entry = index < 0
      ? { signature, clientId: generateUUID() }
      : available.splice(index, 1)[0]!
    previous.push(entry)
    return { ...item, client_id: entry.clientId }
  })
}

const QUICK_PHRASES = ['午饭', '早饭', '咖啡', '打车', '地铁', '买菜', '晚饭', '零食']

const todayTotal = computed(() =>
  todayTransactions.value
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + t.amount, 0),
)

onMounted(() => { fetchToday() })

/**
 * 已经在记一笔页上时，全局「记一笔」不应该在页面上再盖一层弹窗——
 * 直接把光标交给这页的输入框。App.vue 靠 route.path !== '/' 避开渲染弹层，
 * 这里负责把焦点接住并把开关复位。
 */
watch(() => quick.state.open, (v: boolean) => {
  if (!v) return
  quick.close()
  nextTick(() => textarea.value?.focus())
})

async function fetchToday() {
  try {
    const t = today()
    const { data } = await api.get('/transactions', {
      params: { start_date: t, end_date: t, page_size: 50 },
    })
    if (data.code === 0) todayTransactions.value = data.data.items
  } catch { /* ignore */ }
}

/** 输入框随内容长高，3–8 行 */
function autoGrow() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(Math.max(el.scrollHeight, 88), 200) + 'px'
}

function appendPhrase(phrase: string) {
  input.value = input.value.trim() ? `${input.value.trim()}，${phrase}` : phrase
  nextTick(autoGrow)
  textarea.value?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleAiParse()
  }
}

async function handleAiParse() {
  if (!input.value.trim() || loading.value || confirming.value) return
  error.value = ''
  loading.value = true
  aiSubmissions = []
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
  toast.warning('已切换到手动模式')
}

function resetComposer() {
  aiSubmissions = []
  parsedItems.value = []
  input.value = ''
  error.value = ''
  nextTick(() => { if (textarea.value) textarea.value.style.height = '88px' })
}

async function handleConfirm(items: any[]) {
  if (confirming.value || !items.length) return
  confirming.value = true
  error.value = ''
  try {
    const payload = identifyItems(items.map((item) => ({
      client_type: 'web',
      source: 'ai',
      source_detail: input.value,
      type: item.type,
      amount: item.amount,
      category_id: item.category_id,
      account_id: item.account_id || undefined,
      target_account_id: item.target_account_id || undefined,
      description: item.description,
      date: item.date,
      ai_raw_input: input.value,
    })), aiSubmissions)

    const { data } = await api.post('/transactions', { items: payload })
    if (data.code !== 0) { error.value = data.message || '保存失败'; return }

    resetComposer()
    toast.success(`已记 ${items.length} 笔`)
    // 仪表读数是常驻的，账记完它必须立刻更新，否则顶部三个数字是假的
    useClusterStore().load(true)
    await fetchToday()
  } catch (e: any) {
    error.value = e.response?.data?.message || '未能确认保存结果，请保持内容不变重试；修改前请先核对流水'
  } finally {
    confirming.value = false
  }
}

async function handleManualSubmit(item: any) {
  // 同步上锁：DOM disabled 尚未更新时的重复事件也不能再发请求。
  if (confirming.value) return
  confirming.value = true
  error.value = ''
  try {
    const items = identifyItems([{
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
    }], manualSubmissions)
    const { data } = await api.post('/transactions', { items })
    if (data.code !== 0) { error.value = data.message || '保存失败'; return }
    manualSubmissions = []
    showManual.value = false
    resetComposer()
    toast.success('记账成功')
    useClusterStore().load(true)
    await fetchToday()
  } catch (e: any) {
    error.value = e.response?.data?.message || '未能确认保存结果，请保持内容不变重试；修改前请先核对流水'
  } finally {
    confirming.value = false
  }
}

function openManual() {
  if (confirming.value) return
  if (!showManual.value) manualSubmissions = []
  showManual.value = true
  error.value = ''
}

function cancelManual() {
  if (confirming.value) return
  showManual.value = false
  manualSubmissions = []
}
</script>

<template>
  <div class="space-y-5">
    <!-- 记一笔 = 动作页。
         旧版报头把「本月支出 / 收入 / 结余」又摆了一遍，和常驻仪表完全重复，
         进来第一眼看到的是三张已经看过的数字。删掉，输入框直接当主角。 -->

    <!-- ═══ 输入区 ═══ -->
    <section class="ledger-block composer-block">
      <div class="lb-inner relative">
        <span class="ledger-label ledger-label-solid text-[0.6875rem] font-semibold tracking-[0.06em]"
              style="color: var(--color-ink-3)">说一句话</span>

        <textarea
          ref="textarea"
          v-model="input"
          rows="3"
          class="composer mt-3"
          placeholder="午饭 32，打车 15"
          :disabled="loading || confirming"
          @input="autoGrow"
          @keydown="onKeydown"
        />

        <div class="flex items-center justify-between gap-3 mt-3">
          <div class="flex items-center gap-2 min-w-0">
            <button
              class="btn btn-primary"
              :disabled="loading || confirming || !input.trim()"
              @click="handleAiParse"
            >
              <span
                v-if="loading"
                class="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin"
              />
              <AppIcon v-else name="spark" :size="14" />
              {{ loading ? 'AI 正在拆解…' : '解析' }}
            </button>
            <button class="btn btn-outline" :disabled="confirming" @click="openManual">手动</button>
          </div>
          <span v-if="!loading" class="text-[0.625rem] shrink-0" style="color: var(--color-ink-4)">
            <span class="amt">{{ input.length }}</span> 字 · Enter 提交
          </span>
        </div>

        <!-- 快捷短语 -->
        <div class="scroll-x flex gap-1.5 mt-3 -mb-1 pb-1">
          <button
            v-for="p in QUICK_PHRASES"
            :key="p"
            type="button"
            class="chip shrink-0"
            :disabled="loading || confirming"
            @click="appendPhrase(p)"
          >{{ p }}</button>
        </div>
      </div>
    </section>

    <Notice v-if="error" tone="danger" @close="error = ''">{{ error }}</Notice>

    <!-- 解析结果：请求期间冻结编辑/取消，避免回包清掉另一个草稿。 -->
    <fieldset v-if="parsedItems.length" :disabled="confirming" :aria-busy="confirming" class="min-w-0">
      <ConfirmCards
        :items="parsedItems"
        @confirm="handleConfirm"
        @cancel="!confirming && resetComposer()"
      />
    </fieldset>

    <!-- 手动表单 -->
    <ManualForm
      v-if="showManual"
      :initial-description="input"
      :loading="confirming"
      @submit="handleManualSubmit"
      @cancel="cancelManual"
    />

    <!-- 今日流水 -->
    <section class="sheet">
      <header class="flex items-center justify-between px-3.5 py-2.5"
              style="border-bottom: 1px solid var(--color-rule); background: var(--color-paper-sunk)">
        <span class="ledger-label ledger-label-solid text-[0.6875rem] font-semibold tracking-[0.06em]"
              style="color: var(--color-ink-3)">今日流水</span>
        <span v-if="todayTotal" class="text-[0.6875rem] amt" style="color: var(--color-ink-3)">
          支出 <Money :value="todayTotal" sign="none" size="sm" tone="muted" />
        </span>
      </header>

      <EmptyState
        v-if="!todayTransactions.length"
        compact
        ruled
        icon="pen"
        title="今天还没有记账"
        description="在上面写一句话，比如「午饭 32，打车 15」"
      />

      <template v-else>
        <SheetRow
          v-for="tx in todayTransactions"
          :key="tx.id"
          clickable
          @click="editing = tx"
        >
          <span class="tx-icon" aria-hidden="true">{{ tx.category_icon || '📦' }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-[0.8125rem] truncate" style="color: var(--color-ink-1)">
              {{ tx.description || tx.category_name || '未分类' }}
            </span>
            <span class="block text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
              {{ tx.category_name }}<template v-if="tx.account_name"> · {{ tx.account_name }}</template>
            </span>
          </span>
          <Money :value="tx.amount" :tone="tx.type === 'expense' ? 'expense' : 'income'" />
        </SheetRow>
      </template>
    </section>

    <EditTransactionModal
      :show="!!editing"
      :transaction="editing"
      @close="editing = null"
      @saved="editing = null; fetchToday()"
    />
  </div>
</template>

<style scoped>
.quick-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper-raised);
}

.composer {
  width: 100%;
  min-height: 5.5rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-sm);
  background: var(--color-paper-raised);
  color: var(--color-ink-1);
  font-family: inherit;
  font-size: 1rem;
  line-height: 1.55;
  resize: none;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
/* 记一块：动作页的主角。左侧一道反相色条——这页唯一「现在要做的事」。
   颜色用 --color-inverse 而非固定色，否则深色系统下这道条会消失。 */
.composer-block {
  border-color: var(--color-rule-strong);
  box-shadow: inset 3px 0 0 var(--color-inverse);
}
.composer::placeholder {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
}
.composer:focus,
.composer:focus-visible {
  outline: none;
  border-color: var(--color-ink-1);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-action) 14%, transparent);
}
.composer:disabled { background: var(--color-paper-sunk); color: var(--color-ink-4); }
</style>
