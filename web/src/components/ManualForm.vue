<script setup lang="ts">
/** 手动记账表单：AI 的 fallback，也是精确记账时的首选。 */
import { ref, onMounted, computed, watch } from 'vue'
import api from '@/api/index'
import TagInput from '@/components/TagInput.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import Money from '@/components/ui/Money.vue'

const props = defineProps<{ initialDescription?: string }>()
const emit = defineEmits<{ submit: [item: any]; cancel: [] }>()

const type = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref('')
const description = ref(props.initialDescription || '')
const date = ref(new Date().toISOString().slice(0, 10))
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const targetAccountId = ref<number | null>(null)
const tags = ref<string[]>([])
const error = ref('')

const categories = ref<any[]>([])
const accounts = ref<any[]>([])

onMounted(async () => {
  try {
    const [catRes, accRes] = await Promise.all([api.get('/categories'), api.get('/accounts')])
    if (catRes.data.code === 0) categories.value = catRes.data.data.items
    if (accRes.data.code === 0) accounts.value = accRes.data.data.items
  } catch { /* ignore */ }
})

const filteredCategories = computed(() => categories.value.filter((c: any) => c.type === type.value))
const amountCents = computed(() => Math.round((parseFloat(amount.value) || 0) * 100))

const TYPES = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
] as const

watch(type, () => { categoryId.value = null })

function handleSubmit() {
  error.value = ''
  if (amountCents.value <= 0) { error.value = '填一个大于 0 的金额'; return }
  if (type.value !== 'transfer' && !categoryId.value) { error.value = '选一个分类'; return }
  if (type.value === 'transfer' && (!accountId.value || !targetAccountId.value)) {
    error.value = '转账需要选择来源和目标账户'
    return
  }
  emit('submit', {
    type: type.value,
    amount: amountCents.value,
    category_id: type.value === 'transfer' ? null : categoryId.value,
    account_id: accountId.value,
    target_account_id: type.value === 'transfer' ? targetAccountId.value : null,
    description: description.value,
    date: date.value,
    tags: tags.value.length > 0 ? tags.value : undefined,
  })
}
</script>

<template>
  <form class="surface" @submit.prevent="handleSubmit">
    <header class="form-head">
      <span class="text-[0.8125rem] font-semibold" style="color: var(--color-ink-1)">手动记账</span>
      <button type="button" class="act flex items-center gap-1" @click="emit('cancel')">
        <AppIcon name="close" :size="12" />关闭
      </button>
    </header>

    <div class="p-4 space-y-3">
      <!-- 类型 -->
      <div class="flex gap-1.5" role="group" aria-label="交易类型">
        <button
          v-for="t in TYPES"
          :key="t.value"
          type="button"
          class="chip flex-1 justify-center"
          :class="{ 'chip-active': type === t.value }"
          @click="type = t.value"
        >{{ t.label }}</button>
      </div>

      <!-- 金额 -->
      <label class="block">
        <span class="field-label">金额（元）</span>
        <input
          v-model="amount"
          type="number"
          step="0.01"
          min="0.01"
          inputmode="decimal"
          class="field !h-12 !text-xl font-semibold amt"
          placeholder="0.00"
        />
      </label>

      <!-- 分类 -->
      <label v-if="type !== 'transfer'" class="block">
        <span class="field-label">分类</span>
        <select v-model="categoryId" class="field">
          <option :value="null">选择分类</option>
          <option v-for="cat in filteredCategories" :key="cat.id" :value="cat.id">
            {{ cat.icon }} {{ cat.name }}
          </option>
        </select>
      </label>

      <!-- 账户 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="field-label">{{ type === 'transfer' ? '转出账户' : '账户' }}</span>
          <select v-model="accountId" class="field">
            <option :value="null">不指定</option>
            <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
              {{ acc.icon }} {{ acc.name }}
            </option>
          </select>
        </label>
        <label v-if="type === 'transfer'" class="block">
          <span class="field-label">转入账户</span>
          <select v-model="targetAccountId" class="field">
            <option :value="null">不指定</option>
            <option
              v-for="acc in accounts.filter(a => a.id !== accountId)"
              :key="acc.id" :value="acc.id"
            >{{ acc.icon }} {{ acc.name }}</option>
          </select>
        </label>
      </div>

      <!-- 备注 + 日期 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="field-label">备注</span>
          <input v-model="description" type="text" class="field" placeholder="选填" />
        </label>
        <label class="block">
          <span class="field-label">日期</span>
          <input v-model="date" type="date" class="field" />
        </label>
      </div>

      <label class="block">
        <span class="field-label">标签</span>
        <TagInput v-model="tags" />
      </label>

      <p v-if="error" class="field-error">{{ error }}</p>

      <div class="flex items-center justify-between gap-3 pt-1">
        <span v-if="amountCents > 0" class="text-xs amt" style="color: var(--color-ink-3)">
          将记为 <Money
            :value="amountCents"
            sign="none"
            size="sm"
            :tone="type === 'income' ? 'income' : type === 'transfer' ? 'info' : 'expense'"
          />
        </span>
        <span v-else />
        <button type="submit" class="btn btn-primary">保存这一笔</button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-paper-sunk);
}
</style>
