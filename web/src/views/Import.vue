<script setup lang="ts">
/**
 * 导入账单 —— **壳**。
 *
 * 只做三件事：把 DOM 事件翻译成流水线动作、展示格式化、把流水线状态渲染成
 * 「四步走」的 UI。业务逻辑（读文件 / 解析 CSV / 归类 / 分片提交 / 统计与重置）
 * 全在 `composables/useBillImport.ts`（C4）——那条链的状态彼此耦合（`fileContent`
 * 决定步骤、`previewItems` 决定可提交集合、`pendingItems` 决定分片数），拆成模板
 * 只会把耦合换成 props 传递，所以按「流水线」抽而不是按 UI 组件抽。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBillImport, type PreviewItem } from '@/composables/useBillImport'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import Money from '@/components/ui/Money.vue'
import Notice from '@/components/ui/Notice.vue'
import Meter from '@/components/ui/Meter.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const router = useRouter()

const {
  source,
  fileName,
  fileSize,
  fileContent,
  loading,
  error,
  previewItems,
  stats,
  imported,
  importLoading,
  includeDuplicates,
  importResult,
  progress,
  duplicateCount,
  pendingItems,
  missingCategoryCount,
  currentStep,
  STEP_TITLES,
  categoriesFor,
  loadCategories,
  readFile,
  parse,
  setItemCategory,
  bulkSetCategory,
  submit,
  reset,
} = useBillImport()

onMounted(loadCategories)

/** 拖拽高亮：纯展示态，不属于流水线 */
const dragOver = ref(false)

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (!files || !files[0]) return
  readFile(files[0])
}

function handleDrop(event: DragEvent) {
  dragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) readFile(file)
}

/* 取值留在 view：模板里没法写 TS 断言，把 `event.target` 收窄成 select 的这一步
   是「DOM → 领域值」的翻译，正是壳该干的事。 */
function onItemCategoryChange(item: PreviewItem, event: Event) {
  setItemCategory(item, (event.target as HTMLSelectElement).value)
}

function onBulkCategoryChange(event: Event) {
  const select = event.target as HTMLSelectElement
  bulkSetCategory(select.value)
  select.value = ''
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'expense': return '支出'
    case 'income': return '收入'
    case 'transfer': return '转账'
    default: return type
  }
}

function typeBadgeClass(type: string): string {
  switch (type) {
    case 'expense': return 'badge-expense'
    case 'income': return 'badge-income'
    case 'transfer': return 'badge-info'
    default: return 'badge'
  }
}
</script>

<template>
  <div>
    <PageHeader title="导入账单" subtitle="微信 / 支付宝 CSV 一键入账">
      <template #actions>
        <button type="button" class="btn btn-quiet btn-sm" @click="router.back()">
          <AppIcon name="arrowLeft" :size="15" />
          返回
        </button>
      </template>
    </PageHeader>

    <!-- 步骤条：光秃秃的四段线读不出「到哪一步了」，
         所以下面补一句「第 n 步 / 共 4 步 · 步骤名」——刻度之外还得有读数。 -->
    <div class="steps mb-1.5">
      <span :class="currentStep > 1 ? 'done' : (currentStep === 1 ? 'current' : '')"></span>
      <span :class="currentStep > 2 ? 'done' : (currentStep === 2 ? 'current' : '')"></span>
      <span :class="currentStep > 3 ? 'done' : (currentStep === 3 ? 'current' : '')"></span>
      <span :class="currentStep >= 4 ? 'done' : (currentStep === 4 ? 'current' : '')"></span>
    </div>
    <p class="mb-6 text-[0.6875rem] amt" style="color: var(--color-ink-3)">
      第 {{ currentStep }} 步 / 共 4 步 · {{ STEP_TITLES[currentStep - 1] }}
    </p>

    <!-- 完成：收据样式 -->
    <div v-if="imported" class="receipt px-6 py-8 text-center">
      <div class="flex justify-center mb-3 text-income">
        <AppIcon name="check" :size="36" :stroke="2" />
      </div>
      <h2 class="text-base font-semibold text-ink-1 mb-4">导入完成</h2>

      <div class="max-w-xs mx-auto text-left space-y-0">
        <div class="kv">
          <span class="kv-k">成功入账</span>
          <span class="kv-v amt-income font-semibold amt">{{ importResult?.success ?? 0 }} 条</span>
        </div>
        <div v-if="duplicateCount && !includeDuplicates" class="kv">
          <span class="kv-k">跳过重复</span>
          <span class="kv-v amt">{{ duplicateCount }} 条</span>
        </div>
        <div v-if="importResult?.failed" class="kv">
          <span class="kv-k">导入失败</span>
          <span class="kv-v amt-expense font-semibold amt">{{ importResult.failed }} 条</span>
        </div>
      </div>

      <div class="flex gap-3 justify-center mt-6">
        <button type="button" class="btn btn-primary" @click="router.push('/ledger')">查看流水</button>
        <button type="button" class="btn btn-outline" @click="reset">继续导入</button>
      </div>
    </div>

    <template v-else>
      <!-- 第 1 步：选来源 -->
      <section class="mb-6">
        <LedgerLabel>选择账单来源</LedgerLabel>
        <div class="grid grid-cols-2 gap-3">
          <button
            type="button"
            class="source-opt"
            :class="source === 'wechat' ? 'source-opt-on' : ''"
            @click="source = 'wechat'"
          >
            <span class="text-2xl">💬</span>
            <span class="text-sm font-medium text-ink-1">微信</span>
            <AppIcon v-if="source === 'wechat'" name="check" :size="16" class="source-check" />
          </button>
          <button
            type="button"
            class="source-opt"
            :class="source === 'alipay' ? 'source-opt-on' : ''"
            @click="source = 'alipay'"
          >
            <span class="text-2xl">💰</span>
            <span class="text-sm font-medium text-ink-1">支付宝</span>
            <AppIcon v-if="source === 'alipay'" name="check" :size="16" class="source-check" />
          </button>
        </div>
      </section>

      <!-- 第 2 步：上传 -->
      <section class="mb-6">
        <LedgerLabel>上传 CSV 文件</LedgerLabel>
        <label
          class="dropzone"
          :class="dragOver ? 'dropzone-on' : ''"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="handleDrop"
        >
          <template v-if="fileName">
            <div class="flex items-center gap-2 text-ink-1">
              <AppIcon name="file" :size="20" />
              <span class="text-sm font-medium truncate max-w-[16rem]">{{ fileName }}</span>
            </div>
            <p v-if="fileSize" class="text-xs text-ink-3 mt-1">{{ formatBytes(fileSize) }}</p>
          </template>
          <template v-else>
            <AppIcon name="upload" :size="26" class="text-ink-4 mb-2" />
            <p class="text-sm text-ink-2">点击选择，或把 CSV 文件拖到这里</p>
          </template>
          <input type="file" accept=".csv" class="hidden" @change="handleFileChange" />
        </label>

        <button
          v-if="fileContent && !previewItems.length"
          type="button"
          class="btn btn-primary btn-block mt-3"
          :disabled="loading"
          @click="parse"
        >
          {{ loading ? '解析中…' : '解析文件' }}
        </button>
      </section>

      <!-- 错误提示 -->
      <Notice v-if="error" tone="danger" class="mb-4">{{ error }}</Notice>

      <!-- 第 3 步：预览 -->
      <section v-if="previewItems.length > 0" class="mb-6">
        <LedgerLabel>预览与归类</LedgerLabel>

        <!-- 统计条 -->
        <div v-if="stats" class="surface p-3 mb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          <span class="text-ink-3">总条数 <strong class="text-ink-1 amt ml-0.5">{{ stats.total }}</strong></span>
          <span class="text-ink-3">可导入 <strong class="text-income amt ml-0.5">{{ pendingItems.length }}</strong></span>
          <span v-if="stats.skipped" class="text-ink-3">跳过 <strong class="text-warn amt ml-0.5">{{ stats.skipped }}</strong></span>
          <span v-if="stats.errors" class="text-ink-3">错误行 <strong class="text-expense amt ml-0.5">{{ stats.errors }}</strong></span>
          <span v-if="duplicateCount" class="text-ink-3">疑似重复 <strong class="text-warn amt ml-0.5">{{ duplicateCount }}</strong></span>
        </div>

        <!-- 包含重复开关 -->
        <label
          v-if="duplicateCount"
          class="flex items-center gap-2.5 mb-3 cursor-pointer notice notice-warn"
        >
          <input
            type="checkbox"
            v-model="includeDuplicates"
            class="w-4 h-4 shrink-0 accent-[color:var(--color-warn)]"
          />
          <span class="text-xs">包含 {{ duplicateCount }} 条疑似重复记录（同类型 + 金额 + 日期 + 描述已存在）</span>
        </label>

        <!-- 批量归类 -->
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs text-ink-3 shrink-0">批量归类</span>
          <select class="field flex-1" @change="onBulkCategoryChange">
            <option value="">选择分类（应用到所有未分类的同类记录）</option>
            <optgroup label="支出">
              <option v-for="c in categoriesFor('expense')" :key="c.id" :value="String(c.id)">
                {{ c.icon }} {{ c.name }}
              </option>
            </optgroup>
            <optgroup label="收入">
              <option v-for="c in categoriesFor('income')" :key="c.id" :value="String(c.id)">
                {{ c.icon }} {{ c.name }}
              </option>
            </optgroup>
          </select>
        </div>

        <!-- 未分类提醒 -->
        <Notice v-if="missingCategoryCount > 0" tone="warn" class="mb-3">
          还有 {{ missingCategoryCount }} 条记录未选分类，补全后才能导入。
        </Notice>

        <!-- ≥md 真表格 -->
        <div class="hidden md:block surface surface-flush">
          <table class="w-full text-sm">
            <thead>
              <tr class="import-th-row">
                <th class="import-th text-left">日期</th>
                <th class="import-th text-left">类型</th>
                <th class="import-th text-right">金额</th>
                <th class="import-th text-left pl-3">描述</th>
                <th class="import-th text-left pl-3">分类</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, idx) in previewItems.slice(0, 50)"
                :key="idx"
                class="import-tr"
                :class="item.duplicate && !includeDuplicates ? 'opacity-45' : ''"
              >
                <td class="import-td text-xs text-ink-3 whitespace-nowrap">{{ item.date }}</td>
                <td class="import-td">
                  <span class="badge" :class="typeBadgeClass(item.type)">{{ getTypeLabel(item.type) }}</span>
                </td>
                <td class="import-td text-right">
                  <Money
                    :value="item.amount"
                    size="sm"
                    :tone="item.type === 'income' ? 'income' : 'neutral'"
                    sign="none"
                    absolute
                  />
                </td>
                <td class="import-td pl-3 text-xs text-ink-2 max-w-[12rem] truncate">
                  {{ item.description }}
                  <span v-if="item.duplicate" class="badge badge-warn ml-1">重复</span>
                </td>
                <td class="import-td pl-3">
                  <select
                    v-if="item.type !== 'transfer'"
                    :value="item.category_id ? String(item.category_id) : ''"
                    class="field field-sm max-w-[9rem]"
                    :class="item.category_id ? '' : 'import-cat-missing'"
                    @change="onItemCategoryChange(item, $event)"
                  >
                    <option value="">未分类</option>
                    <option v-for="c in categoriesFor(item.type)" :key="c.id" :value="String(c.id)">
                      {{ c.icon }} {{ c.name }}
                    </option>
                  </select>
                  <span v-else class="text-xs text-ink-4">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- <md 卡片行 -->
        <div class="md:hidden sheet">
          <div
            v-for="(item, idx) in previewItems.slice(0, 50)"
            :key="idx"
            class="sheet-row flex-col items-stretch gap-2"
            :class="item.duplicate && !includeDuplicates ? 'opacity-45' : ''"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="badge shrink-0" :class="typeBadgeClass(item.type)">{{ getTypeLabel(item.type) }}</span>
                <span class="text-xs text-ink-3 shrink-0">{{ item.date }}</span>
                <span v-if="item.duplicate" class="badge badge-warn shrink-0">重复</span>
              </div>
              <Money
                :value="item.amount"
                size="sm"
                :tone="item.type === 'income' ? 'income' : 'neutral'"
                sign="none"
                absolute
              />
            </div>
            <p class="text-xs text-ink-2 truncate">{{ item.description }}</p>
            <select
              v-if="item.type !== 'transfer'"
              :value="item.category_id ? String(item.category_id) : ''"
              class="field field-sm"
              :class="item.category_id ? '' : 'import-cat-missing'"
              @change="onItemCategoryChange(item, $event)"
            >
              <option value="">未分类</option>
              <option v-for="c in categoriesFor(item.type)" :key="c.id" :value="String(c.id)">
                {{ c.icon }} {{ c.name }}
              </option>
            </select>
          </div>
        </div>

        <p v-if="previewItems.length > 50" class="text-center text-xs text-ink-4 mt-2">
          仅显示前 50 条，共 {{ previewItems.length }} 条
        </p>

        <!-- 导入进度：细进度条 -->
        <div v-if="progress" class="mt-4">
          <div class="flex justify-between text-xs text-ink-3 mb-1.5">
            <span>正在导入…</span>
            <span class="amt">{{ progress.done }} / {{ progress.total }}</span>
          </div>
          <Meter :percent="Math.round((progress.done / progress.total) * 100)" tone="ink" height="xs" />
        </div>

        <!-- 确认导入 -->
        <div class="flex gap-3 mt-4">
          <button
            type="button"
            class="btn btn-primary flex-1"
            :disabled="importLoading || missingCategoryCount > 0"
            @click="submit"
          >
            <template v-if="importLoading">导入中…</template>
            <template v-else-if="missingCategoryCount > 0">还有 {{ missingCategoryCount }} 条未选分类</template>
            <template v-else>确认导入 {{ pendingItems.length }} 条</template>
          </button>
          <button type="button" class="btn btn-outline" :disabled="importLoading" @click="reset">取消</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.source-opt {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1.25rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-rule-strong);
  background: var(--color-paper-raised);
  transition: border-color 0.14s ease, background-color 0.14s ease;
}
.source-opt:hover { border-color: var(--color-ink-4); }
.source-opt-on {
  border-color: var(--color-ink-1);
  background: var(--color-paper-hover);
}
.source-check {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  color: var(--color-ink-1);
}

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 7.5rem;
  padding: 1.25rem;
  border-radius: var(--radius-md);
  border: 2px dashed var(--color-rule-strong);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.14s ease, background-color 0.14s ease;
}
.dropzone:hover { border-color: var(--color-ink-4); }
.dropzone-on {
  border-color: var(--color-ink-1);
  background: var(--color-paper-hover);
}

.import-th-row { border-bottom: 1px solid var(--color-rule); }
.import-th {
  padding: 0.5rem 0.625rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-ink-3);
  letter-spacing: 0.02em;
}
.import-tr { border-top: 1px solid var(--color-rule-faint); }
.import-tr:first-child { border-top: 0; }
.import-td { padding: 0.5rem 0.625rem; vertical-align: middle; }

.field-sm {
  height: 1.875rem;
  font-size: 0.75rem;
  padding: 0 0.5rem;
}
select.field-sm { padding-right: 1.75rem; }
.import-cat-missing {
  border-color: var(--color-warn-line);
  background: var(--color-warn-soft);
  color: var(--color-warn);
}
</style>
