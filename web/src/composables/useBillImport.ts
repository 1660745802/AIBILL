/**
 * 导入流水线（C4：从 `views/Import.vue` 抽出的业务逻辑）
 *
 * 「选来源 → 读文件 → 解析 CSV → 预览归类 → 分片提交」这条链的状态与动作全在这里，
 * view 只留**步骤 UI 与装配**（DOM 事件 → 本模块的动作、展示格式化）。
 *
 * 为什么按「流水线」抽而不是按 UI 组件抽：这条链的状态彼此耦合（`fileContent` 决定
 * 步骤、`previewItems` 决定可提交集合、`pendingItems` 决定分片数量），拆模板只是把
 * 耦合换成 props 传递；抽成 composable 才让「导入这件事」有独立的 interface。
 *
 * `setItemCategory`/`bulkSetCategory` 收 `categoryId` 字符串（DOM 取值留在 view），
 * `parse`/`submit` 管理解析与提交。提交 ID 在同一预览行的未改内容重试间保持稳定，
 * 批量归类只填补未分类行，不覆盖已有分类。
 */
import { ref, computed } from 'vue'
import api from '@/api/index'
import { generateUUID } from '@/utils/uuid'
import { useToast } from '@/composables/useToast'

/** 账单来源（决定服务端按哪家的格式解析 CSV） */
export type ImportSource = 'wechat' | 'alipay'

/** 预览行：`category_auto` 标记是否服务端自动归类（用户手选过就不再自动） */
export interface PreviewItem {
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

export interface ImportCategory {
  id: number
  name: string
  type: 'expense' | 'income'
  icon: string
}

/** 解析阶段的服务端统计（与 `previewItems` 不同维度：总条数/跳过/错误/疑似重复） */
export interface ImportStats {
  total: number
  skipped: number
  errors: number
  duplicates: number
}

/** 单次提交的分片大小（服务端上限 200，留出余量） */
const CHUNK_SIZE = 100

export const STEP_TITLES = ['选择来源', '上传账单', '预览校对', '导入完成']

export function useBillImport() {
  const toast = useToast()

  const source = ref<ImportSource>('wechat')
  const fileContent = ref('')
  const fileName = ref('')
  const fileSize = ref(0)
  const loading = ref(false)
  const error = ref('')

  const previewItems = ref<PreviewItem[]>([])
  const categories = ref<ImportCategory[]>([])
  const stats = ref<ImportStats | null>(null)
  const imported = ref(false)
  const importLoading = ref(false)
  /** 是否把疑似重复的记录也导入（默认否，避免重复导入把金额翻倍） */
  const includeDuplicates = ref(false)
  /** 导入结果统计 */
  const importResult = ref<{ success: number; failed: number; failedItems: number[] } | null>(null)
  const progress = ref<{ done: number; total: number } | null>(null)
  // 同一预览行的同一内容复用幂等 ID；响应丢失不等于服务端没入库。
  const submissions = new WeakMap<PreviewItem, { signature: string; clientId: string }>()

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
  function categoriesFor(type: string): ImportCategory[] {
    return categories.value.filter((c) => c.type === (type === 'income' ? 'income' : 'expense'))
  }

  async function loadCategories() {
    try {
      const { data } = await api.get('/categories')
      if (data.code === 0) categories.value = data.data.items || []
    } catch { /* 忽略：分类加载失败不影响导入，只是无法自动分类 */ }
  }

  /** 读文件（异步；成功后 `fileContent` 才有值，步骤随之推进） */
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

  /** 把 CSV 内容交给服务端解析成预览行 */
  async function parse() {
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

  /** 手动修改某一行的分类（`categoryId` 为空串 = 未分类） */
  function setItemCategory(item: PreviewItem, categoryId: string) {
    const cat = categories.value.find((c) => String(c.id) === categoryId)
    item.category_id = cat ? cat.id : null
    item.category_name = cat ? cat.name : null
    item.category_icon = cat ? cat.icon : null
    item.category_auto = false // 用户手动选过，不再标记为自动
  }

  /** 批量把未分类的行归到指定分类（转账与类型不匹配的行不动） */
  function bulkSetCategory(categoryId: string) {
    if (!categoryId) return
    const cat = categories.value.find((c) => String(c.id) === categoryId)
    if (!cat) return
    for (const item of previewItems.value) {
      if (item.type === 'transfer' || item.category_id != null) continue
      if (item.type === cat.type) {
        item.category_id = cat.id
        item.category_name = cat.name
        item.category_icon = cat.icon
        item.category_auto = false
      }
    }
  }

  /** 分片提交：单批失败不影响其他批，最终汇总而不是「一错全无」 */
  async function submit() {
    if (importLoading.value || pendingItems.value.length === 0) return
    if (missingCategoryCount.value > 0) {
      error.value = `还有 ${missingCategoryCount.value} 条记录未选分类，请先补全或删除`
      return
    }

    importLoading.value = true
    error.value = ''
    importResult.value = null
    progress.value = { done: 0, total: pendingItems.value.length }

    // 在首个 await 前固定本轮内容，避免中途编辑改变尚未提交的分片。
    const toSubmit = pendingItems.value.map((item) => {
      const payload = {
        client_type: 'web' as const,
        source: 'import_csv' as const,
        source_detail: item.source_detail || item.description || '',
        type: item.type,
        amount: item.amount,
        category_id: item.category_id || undefined,
        description: item.description,
        date: item.date,
      }
      const signature = JSON.stringify(payload)
      let submission = submissions.get(item)
      if (!submission || submission.signature !== signature) {
        submission = { signature, clientId: generateUUID() }
        submissions.set(item, submission)
      }
      return { ...payload, client_id: submission.clientId }
    })
    let success = 0
    let failed = 0
    const failedIndexes: number[] = []

    try {
      for (let i = 0; i < toSubmit.length; i += CHUNK_SIZE) {
        const chunk = toSubmit.slice(i, i + CHUNK_SIZE)

        try {
          const { data } = await api.post('/transactions', { items: chunk })
          if (data.code === 0) {
            // 幂等重试返回 duplicates，也代表这笔已被服务端确认入账。
            success += data.data?.created
              ? data.data.created.length + (data.data.duplicates?.length ?? 0)
              : chunk.length
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
      // 部分失败时仍留在预览供重试；已成功行凭相同 ID 不会重复入账。
      imported.value = success > 0 && failed === 0
      if (failed > 0) {
        error.value = `${failed} 条未能确认导入结果，可保持内容不变重试；修改前请先核对流水`
        toast.error(error.value)
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

  return {
    // 状态
    source,
    fileContent,
    fileName,
    fileSize,
    loading,
    error,
    previewItems,
    categories,
    stats,
    imported,
    importLoading,
    includeDuplicates,
    importResult,
    progress,
    // 派生状态
    duplicateCount,
    pendingItems,
    missingCategoryCount,
    currentStep,
    STEP_TITLES,
    // 动作
    categoriesFor,
    loadCategories,
    readFile,
    parse,
    setItemCategory,
    bulkSetCategory,
    submit,
    reset,
  }
}
