<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/index'
import { generateUUID } from '@/utils/uuid'
import { useToast } from '@/composables/useToast'
import PageHeader from '@/components/ui/PageHeader.vue'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import Money from '@/components/ui/Money.vue'
import Notice from '@/components/ui/Notice.vue'
import Meter from '@/components/ui/Meter.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const router = useRouter()
const toast = useToast()

type Source = 'wechat' | 'alipay'

const source = ref<Source>('wechat')
const fileContent = ref('')
const fileName = ref('')
const fileSize = ref(0)
const dragOver = ref(false)
const loading = ref(false)
const error = ref('')

// 预览数据
interface PreviewItem {
  type: string
  amount: number
  description: string
  date: string
  source_detail: string
  category_id: number | null
  category_name: string | null
  category_icon: string | null
  category_auto: boolean
  duplicate: boolean
}

interface Category {
  id: number
  name: string
  type: 'expense' | 'income'
  icon: string
}

const previewItems = ref<PreviewItem[]>([])
const categories = ref<Category[]>([])
const stats = ref<{ total: number; skipped: number; errors: number; duplicates: number } | null>(null)
const imported = ref(false)
const importLoading = ref(false)
/** 是否把疑似重复的记录也导入（默认否，避免重复导入把金额翻倍） */
const includeDuplicates = ref(false)
/** 导入结果统计 */
const importResult = ref<{ success: number; failed: number; failedItems: number[] } | null>(null)
const progress = ref<{ done: number; total: number } | null>(null)

/** 单次提交的分片大小（服务端上限 200，留出余量） */
const CHUNK_SIZE = 100

const duplicateCount = computed(() => previewItems.value.filter((i) => i.duplicate).length)
/** 实际会提交的条目（按“包含重复”开关过滤） */
const pendingItems = computed(() =>
  includeDuplicates.value ? previewItems.value : previewItems.value.filter((i) => !i.duplicate),
)
/** 缺分类的非转账条目（无法入库，需用户补选） */
const missingCategoryCount = computed(
  () => pendingItems.value.filter((i) => i.type !== 'transfer' && !i.category_id).length,
)

/** 当前步骤：1 选来源 / 2 上传 / 3 预览 / 4 完成 */
const currentStep = computed(() => {
  if (imported.value) return 4
  if (previewItems.value.length > 0) return 3
  if (fileContent.value) return 2
  return fileName.value ? 2 : 1
})

/** 与当前类型匹配的分类（用于下拉框） */
function categoriesFor(type: string): Category[] {
  return categories.value.filter((c) => c.type === (type === 'income' ? 'income' : 'expense'))
}

onMounted(loadCategories)

async function loadCategories() {
  try {
    const { data } = await api.get('/categories')
    if (data.code === 0) categories.value = data.data.items || []
  } catch { /* 忽略：分类加载失败不影响导入，只是无法自动分类 */ }
}

function readFile(file: File) {
  fileName.value = file.name
  fileSize.value = file.size
  error.value = ''
  const reader = new FileReader()
  reader.onload = (e) => {
    fileContent.value = e.target?.result as string
  }
  reader.onerror = () => {
    error.value = '文件读取失败'
  }
  reader.readAsText(file, 'utf-8')
}

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function parseCsv() {
  if (!fileContent.value) {
    error.value = '请先选择文件'
    return
  }

  loading.value = true
  error.value = ''
  previewItems.value = []
  stats.value = null
  importResult.value = null

  try {
    const { data } = await api.post('/import/csv', {
      content: fileContent.value,
      source: source.value,
    })
    if (data.code === 0) {
      previewItems.value = data.data.parsed || []
      stats.value = {
        total: data.data.total ?? previewItems.value.length,
        skipped: data.data.skipped ?? 0,
        errors: data.data.errors ?? 0,
        duplicates: data.data.duplicates ?? 0,
      }
      if (previewItems.value.length === 0) {
        error.value = '没有解析出可导入的记录，请确认账单格式选择是否正确'
      }
    } else {
      error.value = data.message || '解析失败'
    }
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    loading.value = false
  }
}

/** 手动修改某一行的分类 */
function setCategory(item: PreviewItem, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const cat = categories.value.find((c) => String(c.id) === value)
  item.category_id = cat ? cat.id : null
  item.category_name = cat ? cat.name : null
  item.category_icon = cat ? cat.icon : null
  item.category_auto = false // 用户手动选过，不再标记为自动
}

/** 批量把未分类的行归到指定分类 */
function bulkCategory(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (!value) return
  const cat = categories.value.find((c) => String(c.id) === value)
  if (!cat) return
  for (const item of previewItems.value) {
    if (item.type === 'transfer') continue
    if (categoriesFor(item.type).some((c) => c.id === cat.id)) {
      item.category_id = cat.id
      item.category_name = cat.name
      item.category_icon = cat.icon
      item.category_auto = false
    }
  }
  ;(event.target as HTMLSelectElement).value = ''
}

async function confirmImport() {
  if (pendingItems.value.length === 0) return
  if (missingCategoryCount.value > 0) {
    error.value = `还有 ${missingCategoryCount.value} 条记录未选分类，请先补全或删除`
    return
  }

  importLoading.value = true
  error.value = ''
  importResult.value = null
  progress.value = { done: 0, total: pendingItems.value.length }

  const toSubmit = pendingItems.value
  let success = 0
  let failed = 0
  const failedIndexes: number[] = []

  try {
    // 分片提交：单批失败不影响其他批，最终汇总而不是“一错全无”
    for (let i = 0; i < toSubmit.length; i += CHUNK_SIZE) {
      const chunk = toSubmit.slice(i, i + CHUNK_SIZE)
      const items = chunk.map((item) => ({
        client_id: generateUUID(),
        client_type: 'web' as const,
        source: 'import_csv' as const,
        source_detail: item.source_detail || item.description || '',
        type: item.type,
        amount: item.amount,
        category_id: item.category_id || undefined,
        description: item.description,
        date: item.date,
      }))

      try {
        const { data } = await api.post('/transactions', { items })
        if (data.code === 0) {
          success += data.data?.created?.length ?? chunk.length
        } else {
          failed += chunk.length
          failedIndexes.push(...chunk.map((_, ci) => i + ci))
        }
      } catch (e: any) {
        failed += chunk.length
        failedIndexes.push(...chunk.map((_, ci) => i + ci))
      }

      progress.value = { done: Math.min(i + CHUNK_SIZE, toSubmit.length), total: toSubmit.length }
    }

    importResult.value = { success, failed, failedItems: failedIndexes }
    if (success > 0) {
      imported.value = true
    }
    if (failed > 0) {
      toast.error(`${failed} 条导入失败，请检查后重试`)
    } else {
      toast.success(`成功导入 ${success} 条`)
    }
  } finally {
    importLoading.value = false
    progress.value = null
  }
}

function reset() {
  fileContent.value = ''
  fileName.value = ''
  fileSize.value = 0
  previewItems.value = []
  stats.value = null
  imported.value = false
  importResult.value = null
  includeDuplicates.value = false
  error.value = ''
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

    <!-- 步骤条 -->
    <div class="steps mb-6">
      <span :class="currentStep > 1 ? 'done' : (currentStep === 1 ? 'current' : '')"></span>
      <span :class="currentStep > 2 ? 'done' : (currentStep === 2 ? 'current' : '')"></span>
      <span :class="currentStep > 3 ? 'done' : (currentStep === 3 ? 'current' : '')"></span>
      <span :class="currentStep >= 4 ? 'done' : (currentStep === 4 ? 'current' : '')"></span>
    </div>

    <!-- 完成：收据样式 -->
    <div v-if="imported" class="receipt paper-ruled px-6 py-8 text-center">
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
          class="dropzone paper-ruled"
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
          @click="parseCsv"
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
          <select class="field flex-1" @change="bulkCategory">
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
                    @change="setCategory(item, $event)"
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
              @change="setCategory(item, $event)"
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
            @click="confirmImport"
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
