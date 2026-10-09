<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import LedgerLabel from '@/components/ui/LedgerLabel.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const categories = ref<any[]>([])
const showAdd = ref(false)
const newName = ref('')
const newType = ref<'expense' | 'income'>('expense')
const newIcon = ref('📦')
const loading = ref(false)

const expenseCats = computed(() => categories.value.filter(c => c.type === 'expense'))
const incomeCats = computed(() => categories.value.filter(c => c.type === 'income'))

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
  <div class="sheet">
    <!-- 头部：标题 + 添加切换 -->
    <div class="flex items-center justify-between px-3.5 py-2.5 border-b border-rule-faint">
      <span class="text-xs font-semibold text-ink-2">分类管理</span>
      <button @click="showAdd = !showAdd" class="act">
        {{ showAdd ? '取消' : '+ 添加' }}
      </button>
    </div>

    <!-- 添加表单（纸下沉底） -->
    <div v-if="showAdd" class="px-3.5 py-3 bg-paper-sunk border-b border-rule-faint space-y-2">
      <div class="flex gap-2">
        <select v-model="newType" class="field w-24">
          <option value="expense">支出</option>
          <option value="income">收入</option>
        </select>
        <input v-model="newIcon" class="field w-12 text-center" maxlength="4" />
        <input
          v-model="newName"
          class="field flex-1"
          placeholder="分类名称"
          @keyup.enter="addCategory"
        />
      </div>
      <div class="flex justify-end">
        <button
          @click="addCategory"
          :disabled="loading || !newName.trim()"
          class="btn btn-primary btn-sm"
        >保存</button>
      </div>
    </div>

    <!-- 支出分类 -->
    <div class="px-3.5 py-3 border-b border-rule-faint">
      <LedgerLabel>支出分类</LedgerLabel>
      <div v-if="expenseCats.length" class="flex flex-wrap gap-1.5">
        <button
          v-for="cat in expenseCats"
          :key="cat.id"
          class="chip"
          :class="cat.is_active ? 'chip-active' : 'line-through opacity-45'"
          @click="toggleCategory(cat.id, cat.is_active)"
        >{{ cat.icon }} {{ cat.name }}</button>
      </div>
      <p v-else class="text-xs text-ink-4">暂无支出分类，用上方「添加」新建。</p>
    </div>

    <!-- 收入分类 -->
    <div class="px-3.5 py-3">
      <LedgerLabel>收入分类</LedgerLabel>
      <div v-if="incomeCats.length" class="flex flex-wrap gap-1.5">
        <button
          v-for="cat in incomeCats"
          :key="cat.id"
          class="chip"
          :class="cat.is_active ? 'chip-active' : 'line-through opacity-45'"
          @click="toggleCategory(cat.id, cat.is_active)"
        >{{ cat.icon }} {{ cat.name }}</button>
      </div>
      <p v-else class="text-xs text-ink-4">暂无收入分类，用上方「添加」新建。</p>
    </div>

    <!-- 说明 -->
    <div class="px-3.5 py-2.5 bg-paper-sunk border-t border-rule-faint flex items-center gap-1.5 text-[11px] text-ink-3">
      <AppIcon name="info" :size="13" />
      点击分类可启用 / 停用，停用后不再出现在记账选项里。
    </div>
  </div>
</template>
