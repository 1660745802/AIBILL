<script setup lang="ts">
/**
 * 确认卡的一行（金额 + 归类信息 + 展开编辑）
 *
 * ## 「归不出来」必须看起来就是「归不出来」
 *
 * 服务端 `category_id: null` 表示**模型/规则没能确定分类**（没有依据，不是「其他」）。
 * 这一行以前把它渲染成「其他」分类的 emoji 图标 + 退化文案，于是
 * 「归不出来」在卡片上看起来像「已经归好了类」——服务端不编造了，前端却替它圆。
 *
 * 现在的口径：
 *   · 图标   → 中性的 tag 图标（**不用「其他」那个 emoji**：它会被读成「其他」）
 *   · 副标题 → 「未归类」+ 一个可点的「选分类」，弱化色（--color-ink-4）
 *              —— 弱化而不是红色/错误态：用户没填分类不是「做错了什么」，
 *                 把它做成警告就是在惩罚用户，和「宁可留空」相悖
 *   · 下拉   → 最前面补一条 `<option :value="null">未归类</option>`（与账户的
 *              「未指定」同一范式），用户可以主动选回未归类
 *   · 按钮   → 该行未归类时「调整」改文案为「选分类」，点击后展开既有编辑面板
 *              并把分类下拉聚焦/滚到可见（**只改文案与焦点，不新增区块**）
 *
 * 不做：不弹填表、不置灰主按钮、不加必填校验、不加二次确认——用户有权
 * 就记成未归类（见父组件 ConfirmCards）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import Money from '@/components/ui/Money.vue'
import type { AccountRef, CategoryRef, ParsedItem } from './confirm-card-types'
import type { ChoiceValue } from './confirm-card-choices'

const props = defineProps<{
  item: ParsedItem
  categories: CategoryRef[]
  accounts: AccountRef[]
  editing: boolean
}>()

const emit = defineEmits<{
  toggle: []
  remove: []
  /** 传**原始选择值**而不是 Number(...)：`<option :value="null">` 在 DOM 上是空串，
   *  Number('') 会变成 id=0，用户的「未归类」会被静默吞掉（见 confirm-card-choices.ts） */
  'update:category': [choice: ChoiceValue]
  'update:account': [choice: ChoiceValue]
  'update:amount': [value: string]
}>()

const categorySelect = ref<HTMLSelectElement | null>(null)

/** 转账：按设计就没有分类（服务端 category_id 恒为 null），**不是**「未归类」 */
const isTransfer = computed(() => props.item.type === 'transfer')

/** 归不出来 = 服务端没给任何分类依据（null / '' 都算）。
 *  转账必须先排除：它天生 category_id=null / category_name=''，不排除的话一行「转账」
 *  会被渲染成「未归类」+「选分类」，而编辑面板里转账根本没有分类下拉（点了没处可选）。 */
const unclassified = computed(
  () => !isTransfer.value && (props.item.category_id === null || props.item.category_name === ''),
)

/** 标题：描述 → 分类名 → 转账/未归类（**不再退化成「支出/收入」**，那行正是在假装已归类） */
const title = computed(
  () => props.item.description || props.item.category_name || (isTransfer.value ? '转账' : '未归类'),
)

const typedCategories = computed(() => props.categories.filter((c) => c.type === props.item.type))

/** 展开且未归类时，把分类下拉聚焦/滚到可见——用户点「选分类」就是为了这一步 */
watch(
  () => props.editing,
  async (open) => {
    if (!open || !unclassified.value) return
    await nextTick()
    const el = categorySelect.value
    if (!el) return
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  },
)

function onToggle() {
  emit('toggle')
}

function onPickCategory() {
  if (props.editing) return
  emit('toggle')
}
</script>

<template>
  <li class="parsed-item">
    <div class="flex items-center gap-3">
      <!-- 转账：双向箭头（它没有分类图标，也不能借「其他」的 📦）；未归类：中性 tag
           （「其他」的 emoji 会把「未定」说成「其他」） -->
      <span v-if="isTransfer" class="tx-icon tx-icon-empty" aria-hidden="true">
        <AppIcon name="switch" :size="14" />
      </span>
      <span v-else-if="unclassified" class="tx-icon tx-icon-empty" aria-hidden="true">
        <AppIcon name="tag" :size="14" />
      </span>
      <span v-else class="tx-icon" aria-hidden="true">{{ item.category_icon || '·' }}</span>

      <div class="min-w-0 flex-1">
        <p class="text-[0.8125rem] truncate" style="color: var(--color-ink-1)">{{ title }}</p>
        <p class="text-[0.6875rem] truncate" style="color: var(--color-ink-3)">
          <template v-if="isTransfer">转账</template>
          <template v-else-if="unclassified">
            <span style="color: var(--color-ink-4)">未归类</span>
            <button type="button" class="link link-quiet unclassified-link" @click="onPickCategory">
              选分类
            </button>
          </template>
          <template v-else>{{ item.category_name }}</template>
          <template v-if="item.account_name"> · {{ item.account_name }}</template>
          <template v-if="isTransfer && item.target_account_name">
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

    <!-- 展开编辑（既有面板，未新增任何区块/字段） -->
    <div v-if="editing" class="parsed-edit">
      <div class="grid grid-cols-2 gap-2">
        <label class="block">
          <span class="field-label">金额</span>
          <input
            :value="(item.amount / 100).toFixed(2)"
            type="number" step="0.01" min="0.01"
            class="field !h-8 !text-xs"
            @change="emit('update:amount', ($event.target as HTMLInputElement).value)"
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
            ref="categorySelect"
            class="field !h-8 !text-xs !px-2"
            :value="item.category_id"
            @change="emit('update:category', ($event.target as HTMLSelectElement).value)"
          >
            <!-- 与账户的「未指定」同一范式：用户可以主动选回未归类。
                 选它 → applyCategoryChoice 真的清空 category_id/name/icon（不是 no-op）。 -->
            <option :value="null">未归类</option>
            <option v-for="cat in typedCategories" :key="cat.id" :value="cat.id">
              {{ cat.icon }} {{ cat.name }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="field-label">账户</span>
          <select
            class="field !h-8 !text-xs !px-2"
            :value="item.account_id"
            @change="emit('update:account', ($event.target as HTMLSelectElement).value)"
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
      <button class="act" @click="onToggle">
        {{ editing ? '收起' : unclassified ? '选分类' : '调整' }}
      </button>
      <button class="act act-danger" @click="emit('remove')">移除</button>
    </div>
  </li>
</template>

<style scoped>
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
/* 未归类标记：中性灰，不做错误态（--color-expense 会把「没填分类」说成「做错了」） */
.tx-icon-empty { color: var(--color-ink-4); display: inline-flex; align-items: center; justify-content: center; }
.unclassified-link { font-size: 0.6875rem; margin-left: 0.25rem; }
</style>
