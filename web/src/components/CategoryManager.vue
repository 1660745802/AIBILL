<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'

const categories = ref<any[]>([])
const showAdd = ref(false)
const newName = ref('')
const newType = ref<'expense' | 'income'>('expense')
const newIcon = ref('📦')
const loading = ref(false)

onMounted(() => fetchCategories())

async function fetchCategories() {
  try {
    const { data } = await api.get('/categories', { params: { include_inactive: '1' } })
    if (data.code === 0) categories.value = data.data.items
  } catch { /* ignore */ }
}

async function addCategory() {
  if (!newName.value.trim()) return
  loading.value = true
  try {
    await api.post('/categories', { name: newName.value.trim(), type: newType.value, icon: newIcon.value })
    newName.value = ''
    showAdd.value = false
    await fetchCategories()
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function toggleCategory(id: number, currentActive: number) {
  try {
    if (currentActive) {
      await api.delete(`/categories/${id}`)
    } else {
      await api.put(`/categories/${id}`, { is_active: 1 })
    }
    await fetchCategories()
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="bg-white px-4 py-4 mb-2">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-medium text-gray-700">分类管理</h3>
      <button @click="showAdd = !showAdd" class="text-xs text-blue-600 hover:text-blue-800">
        {{ showAdd ? '取消' : '+ 添加' }}
      </button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAdd" class="flex gap-2 mb-3">
      <select v-model="newType" class="px-2 py-1 border border-gray-300 rounded text-xs">
        <option value="expense">支出</option>
        <option value="income">收入</option>
      </select>
      <input v-model="newIcon" class="w-10 px-1 py-1 border border-gray-300 rounded text-center text-sm" maxlength="4" />
      <input
        v-model="newName"
        class="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
        placeholder="分类名称"
        @keyup.enter="addCategory"
      />
      <button
        @click="addCategory"
        :disabled="loading || !newName.trim()"
        class="px-3 py-1 bg-blue-600 text-white text-xs rounded disabled:opacity-50"
      >
        保存
      </button>
    </div>

    <!-- 支出分类 -->
    <div class="mb-2">
      <div class="text-xs text-gray-400 mb-1">支出</div>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="cat in categories.filter(c => c.type === 'expense')"
          :key="cat.id"
          class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors"
          :class="cat.is_active ? 'bg-gray-100 text-gray-700' : 'bg-gray-50 text-gray-300 line-through'"
          @click="toggleCategory(cat.id, cat.is_active)"
        >
          {{ cat.icon }} {{ cat.name }}
        </span>
      </div>
    </div>

    <!-- 收入分类 -->
    <div>
      <div class="text-xs text-gray-400 mb-1">收入</div>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="cat in categories.filter(c => c.type === 'income')"
          :key="cat.id"
          class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors"
          :class="cat.is_active ? 'bg-gray-100 text-gray-700' : 'bg-gray-50 text-gray-300 line-through'"
          @click="toggleCategory(cat.id, cat.is_active)"
        >
          {{ cat.icon }} {{ cat.name }}
        </span>
      </div>
    </div>

    <p class="text-xs text-gray-400 mt-2">点击分类可启用/停用</p>
  </div>
</template>
