<script setup lang="ts">
/**
 * AI 解析结果确认卡。每条可单独改分类/账户/金额/日期或删除，
 * 删除最后一条时自动收起（emit cancel），把界面让回给输入框。
 *
 * ## 「归不出来」的呈现口径（产品不可违背的那条：宁可留空也不编造）
 *
 * 服务端 `category_id: null` = **没有依据能确定分类**（不是「其他」）。
 * ⚠️ 转账（transfer）按设计也没有分类，但它**不是**「未归类」：所有「未归类」
 *    判断都必须先排除 transfer（否则一行转账会被说成「未归类」并要求选分类）。
 * 这一层以前用「其他」分类的 emoji 图标 + 类型退化文案把它伪装成已归类；
 * 现在由 ConfirmCardRow 如实呈现
 * （中性图标 + 弱化的「未归类」+ 可点的「选分类」）。
 *
 * **摩擦不许升级成填表**：不弹 ManualForm、不置灰「确认入账」、不新增必填校验、
 * 不加二次确认。用户有权就记成未归类 —— 只在按钮下方给一行**不阻塞**的提示。
 * （ManualForm 只在「AI 没听出账目 → failToManual」时出现，与 null 无关，不动它。）
 */
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import AppIcon from '@/components/ui/AppIcon.vue'
import Money from '@/components/ui/Money.vue'
import ConfirmCardRow from '@/components/ConfirmCardRow.vue'
import type { AccountRef, CategoryRef, ParsedItem } from './confirm-card-types'
import { applyAccountChoice, applyCategoryChoice, type ChoiceValue } from './confirm-card-choices'

const props = defineProps<{ items: ParsedItem[] }>()
const emit = defineEmits<{ confirm: [items: ParsedItem[]]; cancel: [] }>()

const editableItems = ref<ParsedItem[]>(JSON.parse(JSON.stringify(props.items)))
const categories = ref<CategoryRef[]>([])
const accounts = ref<AccountRef[]>([])
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
/** 有未归类的笔时才提示，避免每次解析都多一行噪音（转账天生无分类，不算「未归类」） */
const hasUnclassified = computed(() =>
  editableItems.value.some((i) => i.type !== 'transfer' && (i.category_id === null || i.category_name === '')),
)

function removeItem(index: number) {
  editableItems.value.splice(index, 1)
  editingIndex.value = null
  if (editableItems.value.length === 0) emit('cancel')
}

function toggleEdit(index: number) {
  editingIndex.value = editingIndex.value === index ? null : index
}

/**
 * 选「未归类」/「未指定」是**真的清空**，不是 no-op。
 *
 * 旧实现是 `Number(value)` + `if (cat && item)`：Vue 下 `<option :value="null">` 的
 * DOM value 是空串 → `Number('')` = 0 → 找不到分类 → 静默不赋值，用户点了没反应。
 * 判定逻辑抽成纯函数放在 confirm-card-choices.ts（可单测），细节见那里的注释。
 */
function updateCategory(index: number, choice: ChoiceValue) {
  const item = editableItems.value[index]
  if (item) applyCategoryChoice(item, choice, categories.value)
}

function updateAccount(index: number, choice: ChoiceValue) {
  const item = editableItems.value[index]
  if (item) applyAccountChoice(item, choice, accounts.value)
}

function updateAmount(index: number, value: string) {
  const cents = Math.round(parseFloat(value) * 100)
  const item = editableItems.value[index]
  if (cents > 0 && item) item.amount = cents
}
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
      <ConfirmCardRow
        v-for="(item, index) in editableItems"
        :key="index"
        :item="item"
        :categories="categories"
        :accounts="accounts"
        :editing="editingIndex === index"
        @toggle="toggleEdit(index)"
        @remove="removeItem(index)"
        @update:category="updateCategory(index, $event)"
        @update:account="updateAccount(index, $event)"
        @update:amount="updateAmount(index, $event)"
      />
    </ul>

    <footer class="parsed-foot">
      <button class="btn btn-outline flex-1" @click="emit('cancel')">取消</button>
      <div class="flex-[2]">
        <button class="btn btn-primary w-full" @click="emit('confirm', editableItems)">
          确认入账<template v-if="hasIncome">（含收入）</template>
        </button>
        <!-- 不阻塞：不拦、不置灰、不引导去填表，只把后果说清楚 -->
        <p v-if="hasUnclassified" class="parsed-hint">未选分类，将记为未归类</p>
      </div>
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

/* 头部：下沉一格的细条，不是深色大块。
   上一版拿 --color-action 铺满整条，弹层里就多出一块抢戏的深色；
   这里的角色是「这一段的标题」，安静即可。 */
.parsed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4375rem 0.875rem;
  background: var(--color-paper-sunk);
  border-bottom: 1px solid var(--color-rule);
  color: var(--color-ink-3);
  font-size: 0.75rem;
  font-weight: 600;
}
.parsed-foot {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 0.875rem;
  border-top: 1px solid var(--color-rule);
  background: var(--color-paper-sunk);
}
/* 弱提示：极弱灰，不用警示色——「没归类」不是错误 */
.parsed-hint {
  margin-top: 0.375rem;
  font-size: 0.6875rem;
  text-align: center;
  color: var(--color-ink-4);
}
</style>
