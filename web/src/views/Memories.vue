<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import api from '@/api/index'
import { useToast } from '@/composables/useToast'

const toast = useToast()

interface Memory {
  id: string
  content: string
  category: 'preference' | 'habit' | 'rule' | 'context'
  source: 'manual' | 'ai_suggested'
  is_active: number
  created_at: string
  updated_at: string
}

type CategoryFilter = 'all' | Memory['category']

const memories = ref<Memory[]>([])
const loading = ref(false)
const activeFilter = ref<CategoryFilter>('all')

// Add form
const showAddForm = ref(false)
const newContent = ref('')
const newCategory = ref<Memory['category']>('preference')
const saving = ref(false)

// Edit state
const editingId = ref<string | null>(null)
const editContent = ref('')
const editSaving = ref(false)

const categoryConfig = {
  preference: { label: '偏好', color: 'bg-blue-100 text-blue-700', gradient: 'from-blue-500 to-blue-600' },
  habit: { label: '习惯', color: 'bg-green-100 text-green-700', gradient: 'from-green-500 to-green-600' },
  rule: { label: '规则', color: 'bg-amber-100 text-amber-700', gradient: 'from-amber-500 to-amber-600' },
  context: { label: '上下文', color: 'bg-purple-100 text-purple-700', gradient: 'from-purple-500 to-purple-600' },
}

const filterTabs: { key: CategoryFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'preference', label: '偏好' },
  { key: 'habit', label: '习惯' },
  { key: 'rule', label: '规则' },
  { key: 'context', label: '上下文' },
]

const filteredMemories = computed(() => {
  if (activeFilter.value === 'all') return memories.value
  return memories.value.filter((m) => m.category === activeFilter.value)
})

const activeCount = computed(() => memories.value.filter((m) => m.is_active).length)

async function fetchMemories() {
  loading.value = true
  try {
    const { data } = await api.get('/memories')
    if (data.code === 0) {
      memories.value = data.data.items
    }
  } catch {
    toast.error('加载记忆失败')
  } finally {
    loading.value = false
  }
}

async function addMemory() {
  if (!newContent.value.trim()) {
    toast.warning('请输入记忆内容')
    return
  }
  saving.value = true
  try {
    const { data } = await api.post('/memories', {
      content: newContent.value.trim(),
      category: newCategory.value,
    })
    if (data.code === 0) {
      memories.value.unshift(data.data)
      newContent.value = ''
      newCategory.value = 'preference'
      showAddForm.value = false
      toast.success('记忆已添加')
    } else {
      toast.error(data.message || '添加失败')
    }
  } catch (e: any) {
    toast.error(e.response?.data?.message || '添加失败')
  } finally {
    saving.value = false
  }
}

function startEdit(memory: Memory) {
  editingId.value = memory.id
  editContent.value = memory.content
}

function cancelEdit() {
  editingId.value = null
  editContent.value = ''
}

async function saveEdit(memory: Memory) {
  if (!editContent.value.trim()) {
    toast.warning('内容不能为空')
    return
  }
  editSaving.value = true
  try {
    const { data } = await api.put(`/memories/${memory.id}`, {
      content: editContent.value.trim(),
    })
    if (data.code === 0) {
      memory.content = editContent.value.trim()
      editingId.value = null
      editContent.value = ''
      toast.success('已更新')
    } else {
      toast.error(data.message || '更新失败')
    }
  } catch (e: any) {
    toast.error(e.response?.data?.message || '更新失败')
  } finally {
    editSaving.value = false
  }
}

async function toggleActive(memory: Memory) {
  const newVal = memory.is_active ? 0 : 1
  try {
    const { data } = await api.put(`/memories/${memory.id}`, {
      is_active: newVal,
    })
    if (data.code === 0) {
      memory.is_active = newVal
    } else {
      toast.error('切换失败')
    }
  } catch {
    toast.error('切换失败')
  }
}

async function deleteMemory(memory: Memory) {
  if (!confirm('确定删除这条记忆？')) return
  try {
    const { data } = await api.delete(`/memories/${memory.id}`)
    if (data.code === 0) {
      memories.value = memories.value.filter((m) => m.id !== memory.id)
      toast.success('已删除')
    } else {
      toast.error('删除失败')
    }
  } catch {
    toast.error('删除失败')
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  return `${month}/${day}`
}

onMounted(fetchMemories)
</script>

<template>
  <div class="px-4 py-5 pb-20">
    <!-- Header -->
    <div class="mb-5">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-bold text-gray-800">🧠 AI 记忆</h1>
          <p class="text-xs text-gray-400 mt-1">
            AI 会记住这些偏好，让记账更懂你
          </p>
        </div>
        <span
          v-if="activeCount > 0"
          class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700"
        >
          {{ activeCount }} 条活跃
        </span>
      </div>
    </div>

    <!-- Filter Tabs -->
    <div class="flex gap-2 mb-4 overflow-x-auto pb-1">
      <button
        v-for="tab in filterTabs"
        :key="tab.key"
        @click="activeFilter = tab.key"
        class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all"
        :class="activeFilter === tab.key
          ? 'bg-gray-800 text-white shadow-sm'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Add Button -->
    <button
      v-if="!showAddForm"
      @click="showAddForm = true"
      class="w-full mb-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors"
    >
      + 添加新记忆
    </button>

    <!-- Add Form -->
    <div
      v-if="showAddForm"
      class="bg-white rounded-xl border border-gray-100 p-4 mb-4 shadow-sm"
    >
      <textarea
        v-model="newContent"
        rows="3"
        class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
        placeholder="例如：午饭默认归类到餐饮，一般用微信支付"
        autofocus
      ></textarea>
      <div class="mt-3 flex items-center justify-between">
        <div class="flex gap-1.5">
          <button
            v-for="(cfg, key) in categoryConfig"
            :key="key"
            @click="newCategory = key as Memory['category']"
            class="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
            :class="newCategory === key
              ? cfg.color + ' ring-1 ring-offset-1 ring-current'
              : 'bg-gray-50 text-gray-400 hover:bg-gray-100'"
          >
            {{ cfg.label }}
          </button>
        </div>
        <div class="flex gap-2">
          <button
            @click="showAddForm = false; newContent = ''"
            class="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
          >
            取消
          </button>
          <button
            @click="addMemory"
            :disabled="saving || !newContent.trim()"
            class="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
        <div class="h-4 bg-gray-100 rounded w-3/4 mb-2"></div>
        <div class="h-3 bg-gray-50 rounded w-1/2"></div>
      </div>
    </div>

    <!-- Memory Cards -->
    <div v-else-if="filteredMemories.length > 0" class="space-y-3">
      <div
        v-for="memory in filteredMemories"
        :key="memory.id"
        class="bg-white rounded-xl border border-gray-100 p-4 transition-all hover:shadow-sm"
        :class="{ 'opacity-50': !memory.is_active }"
      >
        <!-- Edit Mode -->
        <div v-if="editingId === memory.id">
          <textarea
            v-model="editContent"
            rows="3"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            autofocus
          ></textarea>
          <div class="mt-2 flex justify-end gap-2">
            <button
              @click="cancelEdit"
              class="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              取消
            </button>
            <button
              @click="saveEdit(memory)"
              :disabled="editSaving || !editContent.trim()"
              class="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {{ editSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <!-- Display Mode -->
        <div v-else>
          <div class="flex items-start justify-between gap-3">
            <p class="text-sm text-gray-700 leading-relaxed flex-1">{{ memory.content }}</p>
            <!-- Toggle Switch -->
            <button
              @click="toggleActive(memory)"
              class="relative flex-shrink-0 w-9 h-5 rounded-full transition-colors"
              :class="memory.is_active ? 'bg-blue-500' : 'bg-gray-200'"
              :title="memory.is_active ? '点击停用' : '点击启用'"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                :class="memory.is_active ? 'translate-x-4' : 'translate-x-0'"
              ></span>
            </button>
          </div>

          <!-- Meta Row -->
          <div class="mt-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium"
                :class="categoryConfig[memory.category]?.color || 'bg-gray-100 text-gray-600'"
              >
                {{ categoryConfig[memory.category]?.label || memory.category }}
              </span>
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-gray-400 bg-gray-50">
                {{ memory.source === 'ai_suggested' ? 'AI 建议' : '手动' }}
              </span>
              <span class="text-[10px] text-gray-300">
                {{ formatDate(memory.created_at) }}
              </span>
            </div>
            <div class="flex items-center gap-1">
              <button
                @click="startEdit(memory)"
                class="p-1 text-gray-300 hover:text-gray-600 transition-colors"
                title="编辑"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                @click="deleteMemory(memory)"
                class="p-1 text-gray-300 hover:text-red-500 transition-colors"
                title="删除"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else class="flex flex-col items-center justify-center py-16 px-4">
      <span class="text-5xl mb-4">🧠</span>
      <p class="text-sm font-medium text-gray-500">还没有记忆</p>
      <p class="mt-1 text-xs text-gray-400 text-center">
        添加你的偏好和习惯，AI 记账会更懂你
      </p>
      <button
        @click="showAddForm = true"
        class="mt-4 px-4 py-2 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
      >
        添加第一条记忆
      </button>
    </div>
  </div>
</template>
