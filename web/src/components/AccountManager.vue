<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

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

// 行内展开编辑
const editingId = ref<number | null>(null)
const editName = ref('')
const editIcon = ref('')
const editBalance = ref('')

function startEdit(acc: any) {
  if (editingId.value === acc.id) { editingId.value = null; return }
  editingId.value = acc.id
  editName.value = acc.name
  editIcon.value = acc.icon
  editBalance.value = ((acc.current_balance ?? acc.initial_balance) / 100).toString()
}

async function saveEdit() {
  if (!editingId.value || !editName.value.trim()) return
  try {
    const balance = Math.round(parseFloat(editBalance.value || '0') * 100)
    await api.put(`/accounts/${editingId.value}`, {
      name: editName.value.trim(),
      icon: editIcon.value,
      current_balance: balance,
    })
    editingId.value = null
    await fetchAccounts()
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="sheet">
    <!-- 头部 -->
    <div class="flex items-center justify-between px-3.5 py-2.5 border-b border-rule-faint">
      <span class="text-xs font-semibold text-ink-2">账户管理</span>
      <button @click="showAdd = !showAdd" class="act">
        {{ showAdd ? '取消' : '+ 添加' }}
      </button>
    </div>

    <!-- 添加表单（纸下沉底） -->
    <div v-if="showAdd" class="px-3.5 py-3 bg-paper-sunk border-b border-rule-faint space-y-2">
      <div class="flex gap-2">
        <input v-model="newIcon" class="field w-12 text-center" maxlength="4" />
        <input v-model="newName" class="field flex-1" placeholder="账户名称" />
        <select v-model="newType" class="field w-24">
          <option value="wechat">微信</option>
          <option value="alipay">支付宝</option>
          <option value="bank">银行卡</option>
          <option value="cash">现金</option>
          <option value="credit">信用卡</option>
          <option value="other">其他</option>
        </select>
      </div>
      <div class="flex gap-2">
        <input v-model="newBalance" type="number" step="0.01" class="field flex-1 amt" placeholder="初始余额（选填）" />
        <button @click="addAccount" :disabled="loading || !newName.trim()" class="btn btn-primary btn-sm">保存</button>
      </div>
    </div>

    <!-- 账户列表 -->
    <template v-for="acc in accounts" :key="acc.id">
      <div
        class="sheet-row sheet-row-click"
        :class="[editingId === acc.id ? 'sheet-row-active' : '', !acc.is_active ? 'opacity-45' : '']"
        role="button"
        tabindex="0"
        @click="startEdit(acc)"
        @keydown.enter="startEdit(acc)"
      >
        <span class="tx-icon">{{ acc.icon }}</span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-ink-1 truncate" :class="!acc.is_active ? 'line-through' : ''">{{ acc.name }}</div>
          <div class="text-[11px] text-ink-3">
            余额 <Money :value="acc.current_balance ?? acc.initial_balance" size="sm" :tone="(acc.current_balance ?? acc.initial_balance) < 0 ? 'expense' : 'muted'" />
          </div>
        </div>
        <button
          @click.stop="toggleAccount(acc.id, acc.is_active)"
          class="act shrink-0"
          :class="acc.is_active ? 'act-danger' : ''"
        >{{ acc.is_active ? '停用' : '启用' }}</button>
        <AppIcon :name="editingId === acc.id ? 'chevronUp' : 'chevronDown'" :size="15" class="text-ink-4 shrink-0" />
      </div>

      <!-- 行内展开编辑：纸下沉底 -->
      <div v-if="editingId === acc.id" class="px-3.5 py-3 bg-paper-sunk border-t border-rule-faint space-y-2">
        <div class="flex gap-2">
          <input v-model="editIcon" class="field w-12 text-center" maxlength="4" />
          <input v-model="editName" class="field flex-1" placeholder="账户名称" />
        </div>
        <div class="flex gap-2">
          <input v-model="editBalance" type="number" step="0.01" class="field flex-1 amt" placeholder="当前余额（元）" />
          <button @click.stop="editingId = null" class="btn btn-quiet btn-sm">取消</button>
          <button @click.stop="saveEdit" class="btn btn-primary btn-sm">保存</button>
        </div>
      </div>
    </template>

    <div v-if="!accounts.length" class="px-3.5 py-6 text-center text-xs text-ink-4">
      还没有账户，用上方「添加」新建一个。
    </div>
  </div>
</template>
