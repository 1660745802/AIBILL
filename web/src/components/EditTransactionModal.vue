<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import api from '@/api/index'
import TagInput from '@/components/TagInput.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useToast } from '@/composables/useToast'
import { useClusterStore } from '@/stores/cluster'

import type { Transaction } from '@/api/types'

const props = defineProps<{ show: boolean; transaction: Transaction | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const confirm = useConfirm()
const toast = useToast()
const cluster = useClusterStore()

const type = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref('')
const description = ref('')
const date = ref('')
const categoryId = ref<number | null>(null)
const accountId = ref<number | null>(null)
const targetAccountId = ref<number | null>(null)
const tags = ref<string[]>([])
const saving = ref(false)
const deleting = ref(false)
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

watch(() => props.transaction, (tx) => {
  if (!tx) return
  type.value = tx.type as 'expense' | 'income' | 'transfer'
  amount.value = (tx.amount / 100).toFixed(2)
  description.value = tx.description || ''
  date.value = tx.date
  categoryId.value = tx.category_id
  accountId.value = tx.account_id
  targetAccountId.value = tx.target_account_id
  error.value = ''
  try { tags.value = tx.tags ? JSON.parse(tx.tags) : [] } catch { tags.value = [] }
}, { immediate: true })

const filteredCategories = computed(() => categories.value.filter((c: any) => c.type === type.value))
const amountCents = computed(() => Math.round((parseFloat(amount.value) || 0) * 100))

const TYPES = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
] as const

async function handleSave() {
  const tx = props.transaction
  if (!tx || saving.value || deleting.value) return
  error.value = ''
  if (amountCents.value <= 0) { error.value = '金额要大于 0'; return }
  saving.value = true
  try {
    const payload: Record<string, any> = {
      type: type.value,
      amount: amountCents.value,
      description: description.value,
      date: date.value,
      tags: tags.value,
    }
    if (type.value === 'transfer') {
      payload.category_id = null
      payload.target_account_id = targetAccountId.value
    } else {
      payload.category_id = categoryId.value
      payload.target_account_id = null
    }
    if (accountId.value) payload.account_id = accountId.value

    const { data } = await api.put(`/transactions/${tx.id}`, payload)
    if (data.code === 0) {
      toast.success('已保存修改')
      cluster.load(true) // 改金额/分类会改变读数，和记账、删除保持同一条规矩
      emit('saved')
    }
    else error.value = data.message || '保存失败'
  } catch (e: any) {
    error.value = e.response?.data?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

/** 删除 = 移入回收站（软删除，30 天内可恢复），所以文案说清去处，而不是只问「确定吗」 */
async function handleDelete() {
  const tx = props.transaction
  if (!tx || saving.value || deleting.value) return
  const ok = await confirm({
    title: '删除这笔记录？',
    body: '会移入回收站，30 天内可以恢复；期间不计入统计和账户余额。',
    confirmText: '移入回收站',
    danger: true,
  })
  if (!ok) return
  deleting.value = true
  error.value = ''
  try {
    const { data } = await api.delete(`/transactions/${tx.id}`)
    if (data.code === 0) {
      toast.success('已移入回收站')
      cluster.load(true) // 顶部读数必须跟上，和记账同一条规矩
      emit('saved')
    } else {
      error.value = data.message || '删除失败'
    }
  } catch (e: any) {
    error.value = e.response?.data?.message || '删除失败'
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <BaseModal
    :show="show"
    title="编辑交易"
    size="md"
    :footer="true"
    :dismissible="!saving && !deleting"
    @close="emit('close')"
  >
    <form class="space-y-3" @submit.prevent="handleSave">
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

      <label class="block">
        <span class="field-label">金额（元）</span>
        <input
          v-model="amount"
          type="number" step="0.01" min="0.01" inputmode="decimal"
          class="field !h-11 !text-lg font-semibold amt"
        />
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label v-if="type !== 'transfer'" class="block">
          <span class="field-label">分类</span>
          <select v-model="categoryId" class="field">
            <option :value="null">未分类</option>
            <option v-for="cat in filteredCategories" :key="cat.id" :value="cat.id">
              {{ cat.icon }} {{ cat.name }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="field-label">{{ type === 'transfer' ? '转出账户' : '账户' }}</span>
          <select v-model="accountId" class="field">
            <option :value="null">未指定</option>
            <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
              {{ acc.icon }} {{ acc.name }}
            </option>
          </select>
        </label>
      </div>

      <label v-if="type === 'transfer'" class="block">
        <span class="field-label">转入账户</span>
        <select v-model="targetAccountId" class="field">
          <option :value="null">未指定</option>
          <option
            v-for="acc in accounts.filter(a => a.id !== accountId)"
            :key="acc.id" :value="acc.id"
          >{{ acc.icon }} {{ acc.name }}</option>
        </select>
      </label>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="field-label">描述</span>
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

      <p v-if="amountCents > 0" class="text-right text-xs amt" style="color: var(--color-ink-3)">
        保存为 <Money
          :value="amountCents"
          sign="none"
          size="sm"
          :tone="type === 'income' ? 'income' : type === 'transfer' ? 'info' : 'expense'"
        />
      </p>
    </form>

    <template #footer>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="btn btn-outline shrink-0"
          style="color: var(--color-expense)"
          :disabled="saving || deleting"
          aria-label="删除这笔记录"
          @click="handleDelete"
        >
          <AppIcon name="trash" :size="15" />
          <span class="hidden sm:inline">{{ deleting ? '删除中…' : '删除' }}</span>
        </button>
        <button class="btn btn-outline flex-1" :disabled="saving || deleting" @click="emit('close')">取消</button>
        <button class="btn btn-primary flex-[2]" :disabled="saving || deleting" @click="handleSave">
          {{ saving ? '保存中…' : '保存修改' }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>
