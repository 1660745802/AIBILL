<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'

const accounts = ref<any[]>([])
const showAdd = ref(false)
const newName = ref('')
const newType = ref('other')
const newIcon = ref('💳')
const newBalance = ref('')
const loading = ref(false)

onMounted(() => fetchAccounts())

async function fetchAccounts() {
  try {
    const { data } = await api.get('/accounts', { params: { include_inactive: '1' } })
    if (data.code === 0) accounts.value = data.data.items
  } catch { /* ignore */ }
}

async function addAccount() {
  if (!newName.value.trim()) return
  loading.value = true
  try {
    const balance = newBalance.value ? Math.round(parseFloat(newBalance.value) * 100) : 0
    await api.post('/accounts', {
      name: newName.value.trim(),
      type: newType.value,
      icon: newIcon.value,
      initial_balance: balance,
    })
    newName.value = ''
    newBalance.value = ''
    showAdd.value = false
    await fetchAccounts()
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function toggleAccount(id: number, currentActive: number) {
  try {
    if (currentActive) {
      await api.delete(`/accounts/${id}`)
    } else {
      await api.put(`/accounts/${id}`, { is_active: 1 })
    }
    await fetchAccounts()
  } catch { /* ignore */ }
}

// 编辑账户
const editingId = ref<number | null>(null)
const editName = ref('')
const editIcon = ref('')
const editBalance = ref('')

function startEdit(acc: any) {
  editingId.value = acc.id
  editName.value = acc.name
  editIcon.value = acc.icon
  editBalance.value = (acc.initial_balance / 100).toString()
}

async function saveEdit() {
  if (!editingId.value || !editName.value.trim()) return
  try {
    const balance = Math.round(parseFloat(editBalance.value || '0') * 100)
    await api.put(`/accounts/${editingId.value}`, {
      name: editName.value.trim(),
      icon: editIcon.value,
      initial_balance: balance,
    })
    editingId.value = null
    await fetchAccounts()
  } catch { /* ignore */ }
}

function formatBalance(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <div class="bg-white px-4 py-4 mb-2">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-medium text-gray-700">账户管理</h3>
      <button @click="showAdd = !showAdd" class="text-xs text-blue-600 hover:text-blue-800">
        {{ showAdd ? '取消' : '+ 添加' }}
      </button>
    </div>

    <!-- 添加表单 -->
    <div v-if="showAdd" class="space-y-2 mb-3 p-2 bg-gray-50 rounded">
      <div class="flex gap-2">
        <input v-model="newIcon" class="w-10 px-1 py-1 border border-gray-300 rounded text-center text-sm" maxlength="4" />
        <input v-model="newName" class="flex-1 px-2 py-1 border border-gray-300 rounded text-sm" placeholder="账户名称" />
        <select v-model="newType" class="px-2 py-1 border border-gray-300 rounded text-xs">
          <option value="wechat">微信</option>
          <option value="alipay">支付宝</option>
          <option value="bank">银行卡</option>
          <option value="cash">现金</option>
          <option value="credit">信用卡</option>
          <option value="other">其他</option>
        </select>
      </div>
      <div class="flex gap-2">
        <input v-model="newBalance" type="number" step="0.01" class="flex-1 px-2 py-1 border border-gray-300 rounded text-sm" placeholder="初始余额（选填）" />
        <button @click="addAccount" :disabled="loading || !newName.trim()" class="px-3 py-1 bg-blue-600 text-white text-xs rounded disabled:opacity-50">
          保存
        </button>
      </div>
    </div>

    <!-- 账户列表 -->
    <div class="space-y-2">
      <div
        v-for="acc in accounts"
        :key="acc.id"
        class="py-2 border-b border-gray-50 last:border-0"
        :class="{ 'opacity-40': !acc.is_active }"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 flex-1 cursor-pointer" @click="startEdit(acc)">
            <span class="text-base">{{ acc.icon }}</span>
            <div>
              <div class="text-sm text-gray-800">{{ acc.name }}</div>
              <div class="text-xs text-gray-400">余额 ¥{{ formatBalance(acc.current_balance ?? acc.initial_balance) }}</div>
            </div>
          </div>
          <div class="flex gap-1.5">
            <button
              @click="startEdit(acc)"
              class="text-xs px-2 py-0.5 rounded border text-gray-500 border-gray-200"
            >
              编辑
            </button>
            <button
              @click="toggleAccount(acc.id, acc.is_active)"
              class="text-xs px-2 py-0.5 rounded border"
              :class="acc.is_active ? 'text-red-400 border-red-200' : 'text-green-500 border-green-200'"
            >
              {{ acc.is_active ? '停用' : '启用' }}
            </button>
          </div>
        </div>
        <!-- 编辑表单 -->
        <div v-if="editingId === acc.id" class="mt-2 p-2 bg-gray-50 rounded space-y-2">
          <div class="flex gap-2">
            <input v-model="editName" class="flex-1 px-2 py-1 border border-gray-300 rounded text-sm" placeholder="账户名称" />
            <input v-model="editIcon" class="w-10 px-1 py-1 border border-gray-300 rounded text-center text-sm" maxlength="4" />
          </div>
          <div class="flex gap-2">
            <input v-model="editBalance" type="number" step="0.01" class="flex-1 px-2 py-1 border border-gray-300 rounded text-sm" placeholder="初始余额（元）" />
            <button @click="saveEdit" class="px-3 py-1 bg-blue-600 text-white text-xs rounded">保存</button>
            <button @click="editingId = null" class="px-3 py-1 text-gray-500 text-xs border border-gray-300 rounded">取消</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
