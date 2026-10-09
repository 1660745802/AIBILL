<script setup lang="ts">
/**
 * AI 解析结果确认卡。每条可单独改分类/账户/金额/日期或删除，
 * 删除最后一条时自动收起（emit cancel），把界面让回给输入框。
 */
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import AppIcon from '@/components/ui/AppIcon.vue'
import Money from '@/components/ui/Money.vue'

interface ParsedItem {
  type: string
  amount: number
  category_id: number | null
  category_name: string
  category_icon: string
  description: string
  date: string
  account_id: number | null
  account_name: string
  target_account_id?: number | null
  target_account_name?: string
}

const props = defineProps<{ items: ParsedItem[] }>()
const emit = defineEmits<{ confirm: [items: ParsedItem[]]; cancel: [] }>()

const editableItems = ref<ParsedItem[]>(JSON.parse(JSON.stringify(props.items)))
const categories = ref<any[]>([])
const accounts = ref<any[]>([])
const editingIndex = ref<number | null>(null)

onMounted(async () => {
  try {
    const [catRes, accRes] = await Promise.all([api.get('/categories'), api.get('/accounts')])
    if (catRes.data.code === 0) categories.value = catRes.data.data.items
    if (accRes.data.code === 0) accounts.value = accRes.data.data.items
  } catch { /* ignore */ }
})

const sum = computed(() => editableItems.value.reduce((s, i) => s + i.amount, 0))
const hasIncome = computed(() => editableItems.value.some((i) => i.type === 'income'))

function removeItem(index: number) {
  editableItems.value.splice(index, 1)
  editingIndex.value = null
  if (editableItems.value.length === 0) emit('cancel')
}

function updateCategory(index: number, categoryId: number) {
  const cat = categories.value.find((c: any) => c.id === categoryId)
  const item = editableItems.value[index]
  if (cat && item) Object.assign(item, { category_id: cat.id, category_name: cat.name, category_icon: cat.icon })
}

function updateAccount(index: number, accountId: number) {
  const acc = accounts.value.find((a: any) => a.id === accountId)
  const item = editableItems.value[index]
  if (acc && item) Object.assign(item, { account_id: acc.id, account_name: acc.name })
}

function updateAmount(index: number, value: string) {
  const cents = Math.round(parseFloat(value) * 100)
  const item = editableItems.value[index]
  if (cents > 0 && item) item.amount = cents
}

const TYPE_LABEL: Record<string, string> = { expense: '支出', income: '收入', transfer: '转账' }
</script>

<template>
  <section class="parsed">
    <header class="parsed-head">
      <span class="flex items-center gap-1.5">
        <AppIcon name="spark" :size="14" />
        <span>AI 拆出 {{ editableItems.length }} 笔</span>
      </span>
      <span class="text-[0.6875rem] amt" style="color: var(--color-ink-3)">
        合计 <Money :value="sum" sign="none" size="sm" tone="muted" />
      </span>
    </header>

    <ul class="parsed-list">
      <li v-for="(item, index) in editableItems" :key="index" class="parsed-item">
        <div class="flex items-center gap-3">
          <span class="tx-icon" aria-hidden="true">{{ item.category_icon || '📦' }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-[0.8125rem] truncate" style="color: var(--color-ink-1)">
              {{ item.description || item.category_name || TYPE_LABEL[item.type] }}
            </p>
            <p class="text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
              {{ item.category_name || TYPE_LABEL[item.type] }}
              <template v-if="item.account_name"> · {{ item.account_name }}</template>
              <template v-if="item.type === 'transfer' && item.target_account_name">
                → {{ item.target_account_name }}
              </template>
            </p>
          </div>
          <div class="text-right shrink-0">
            <Money
              :value="item.amount"
              :tone="item.type === 'income' ? 'income' : item.type === 'transfer' ? 'info' : 'expense'"
            />
            <p class="text-[0.625rem] amt" style="color: var(--color-ink-4)">{{ item.date }}</p>
          </div>
        </div>

        <!-- 展开编辑 -->
        <div v-if="editingIndex === index" class="parsed-edit">
          <div class="grid grid-cols-2 gap-2">
            <label class="block">
              <span class="field-label">金额</span>
              <input
                :value="(item.amount / 100).toFixed(2)"
                type="number" step="0.01" min="0.01"
                class="field !h-8 !text-xs"
                @change="updateAmount(index, ($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="block">
              <span class="field-label">日期</span>
              <input v-model="item.date" type="date" class="field !h-8 !text-xs" />
            </label>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <label v-if="item.type !== 'transfer'" class="block">
              <span class="field-label">分类</span>
              <select
                class="field !h-8 !text-xs !px-2"
                :value="item.category_id"
                @change="updateCategory(index, Number(($event.target as HTMLSelectElement).value))"
              >
                <option
                  v-for="cat in categories.filter((c: any) => c.type === item.type)"
                  :key="cat.id" :value="cat.id"
                >{{ cat.icon }} {{ cat.name }}</option>
              </select>
            </label>
            <label class="block">
              <span class="field-label">账户</span>
              <select
                class="field !h-8 !text-xs !px-2"
                :value="item.account_id"
                @change="updateAccount(index, Number(($event.target as HTMLSelectElement).value))"
              >
                <option :value="null">未指定</option>
                <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                  {{ acc.icon }} {{ acc.name }}
                </option>
              </select>
            </label>
          </div>
        </div>

        <div class="parsed-actions">
          <button class="act" @click="editingIndex = editingIndex === index ? null : index">
            {{ editingIndex === index ? '收起' : '调整' }}
          </button>
          <button class="act act-danger" @click="removeItem(index)">移除</button>
        </div>
      </li>
    </ul>

    <footer class="parsed-foot">
      <button class="btn btn-outline flex-1" @click="emit('cancel')">取消</button>
      <button class="btn btn-primary flex-[2]" @click="emit('confirm', editableItems)">
        确认入账<template v-if="hasIncome">（含收入）</template>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.parsed {
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  overflow: hidden;
  animation: rise-in 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes rise-in { from { opacity: 0; transform: translateY(10px); } }

.parsed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.875rem;
  background: var(--color-action);
  color: var(--color-action-fg);
  font-size: 0.75rem;
  font-weight: 600;
}
.parsed-item { padding: 0.6875rem 0.875rem; border-top: 1px solid var(--color-rule-faint); }
.parsed-item:first-child { border-top: 0; }
.parsed-edit {
  margin-top: 0.625rem;
  padding: 0.625rem;
  display: grid;
  gap: 0.5rem;
  background: var(--color-paper-sunk);
  border-radius: var(--radius-sm);
}
.parsed-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}
.parsed-foot {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 0.875rem;
  border-top: 1px solid var(--color-rule);
  background: var(--color-paper-sunk);
}
</style>
