<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getGoals, createGoal, updateGoal, deleteGoal } from '@/api/goals'
import type { Goal } from '@/api/goals'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const loading = ref(true)
const goals = ref<Goal[]>([])
const showForm = ref(false)
const editingId = ref<number | null>(null)
const statusFilter = ref('active')

const form = ref({
  name: '',
  type: 'saving' as 'saving' | 'debt_payoff' | 'investment' | 'custom',
  target_amount: 0,
  current_amount: 0,
  deadline: '',
  priority: 5,
  monthly_contribution: 0,
  icon: '🎯',
  note: '',
})

const typeLabels: Record<string, string> = { saving: '储蓄', debt_payoff: '还贷', investment: '投资', custom: '自定义' }
const statusLabels: Record<string, string> = { active: '进行中', completed: '已完成', paused: '已暂停', abandoned: '已放弃' }
const icons = ['🎯', '🏠', '🚗', '✈️', '💍', '📱', '🎓', '💪', '🏖️', '💰']

function fmt(cents: number): string {
  return `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0 })}`
}

function daysLeft(deadline: string | null): string {
  if (!deadline) return ''
  const diff = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  if (diff < 0) return '已逾期'
  if (diff === 0) return '今天到期'
  return `${diff}天`
}

async function loadGoals() {
  loading.value = true
  try { const res = await getGoals(statusFilter.value); goals.value = res.data.data.items }
  catch { toast.error('加载失败') }
  finally { loading.value = false }
}

function openCreate() {
  editingId.value = null
  form.value = { name: '', type: 'saving', target_amount: 0, current_amount: 0, deadline: '', priority: 5, monthly_contribution: 0, icon: '🎯', note: '' }
  showForm.value = true
}

function openEdit(goal: Goal) {
  editingId.value = goal.id
  form.value = { name: goal.name, type: goal.type, target_amount: goal.target_amount / 100, current_amount: goal.current_amount / 100, deadline: goal.deadline || '', priority: goal.priority, monthly_contribution: goal.monthly_contribution / 100, icon: goal.icon, note: goal.note || '' }
  showForm.value = true
}

async function handleSubmit() {
  if (!form.value.name.trim()) { toast.error('请输入目标名称'); return }
  if (form.value.target_amount <= 0) { toast.error('目标金额必须大于0'); return }
  const payload = { ...form.value, target_amount: Math.round(form.value.target_amount * 100), current_amount: Math.round(form.value.current_amount * 100), monthly_contribution: Math.round(form.value.monthly_contribution * 100), deadline: form.value.deadline || undefined, note: form.value.note || undefined }
  try {
    if (editingId.value) { await updateGoal(editingId.value, payload); toast.success('已更新') }
    else { await createGoal(payload); toast.success('已创建') }
    showForm.value = false; await loadGoals()
  } catch { toast.error('操作失败') }
}

async function handleDelete(id: number) {
  if (!confirm('确定删除此目标？')) return
  try { await deleteGoal(id); toast.success('已删除'); await loadGoals() }
  catch { toast.error('删除失败') }
}

async function handleStatus(goal: Goal, status: string) {
  try { await updateGoal(goal.id, { status } as any); toast.success('已更新'); await loadGoals() }
  catch { toast.error('失败') }
}

function progressColor(p: number): string {
  if (p >= 100) return 'var(--color-income)'
  if (p >= 75) return 'var(--color-primary-500)'
  if (p >= 50) return '#f59e0b'
  return 'var(--color-border)'
}

onMounted(loadGoals)
</script>

<template>
  <div class="pb-20 md:pb-4">
    <div class="flex items-center justify-between mb-5">
      <div>
        <h1 class="page-title">财务目标</h1>
        <p class="page-subtitle">追踪你的储蓄和还贷进度</p>
      </div>
      <button @click="openCreate" class="btn-primary text-xs">+ 新目标</button>
    </div>

    <!-- 筛选 -->
    <div class="flex gap-2 mb-4 overflow-x-auto pb-1">
      <button
        v-for="(label, key) in { ...statusLabels, all: '全部' }" :key="key"
        @click="statusFilter = key; loadGoals()"
        class="text-xs px-3 py-1.5 rounded-md whitespace-nowrap transition font-medium"
        :style="statusFilter === key
          ? 'background: var(--color-primary-50); color: var(--color-primary-700)'
          : 'background: transparent; color: var(--color-text-muted)'"
      >{{ label }}</button>
    </div>

    <div v-if="loading" class="space-y-3 animate-pulse">
      <div v-for="i in 3" :key="i" class="h-28 rounded-xl" style="background: var(--color-border-light)"></div>
    </div>

    <!-- 目标列表 -->
    <div v-else-if="goals.length > 0" class="space-y-3">
      <div v-for="goal in goals" :key="goal.id" class="card">
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2.5">
            <span class="text-xl">{{ goal.icon }}</span>
            <div>
              <h3 class="text-sm font-medium" style="color: var(--color-text-primary)">{{ goal.name }}</h3>
              <p class="text-[11px]" style="color: var(--color-text-muted)">
                {{ typeLabels[goal.type] }}
                <span v-if="goal.deadline" class="ml-1" :style="daysLeft(goal.deadline) === '已逾期' ? 'color: var(--color-expense)' : ''">
                  · {{ daysLeft(goal.deadline) }}
                </span>
              </p>
            </div>
          </div>
          <div class="flex gap-2">
            <button @click="openEdit(goal)" class="text-[11px]" style="color: var(--color-primary-600)">编辑</button>
            <button @click="handleDelete(goal.id)" class="text-[11px]" style="color: var(--color-text-muted)">删除</button>
          </div>
        </div>

        <!-- 进度 -->
        <div class="mb-2">
          <div class="flex justify-between text-[11px] mb-1.5" style="color: var(--color-text-muted)">
            <span>{{ fmt(goal.current_amount) }}</span>
            <span class="font-medium" style="color: var(--color-text-secondary)">{{ goal.percent }}%</span>
            <span>{{ fmt(goal.target_amount) }}</span>
          </div>
          <div class="progress-bar !h-2">
            <div class="progress-bar-fill" :style="{ width: `${Math.min(100, goal.percent)}%`, background: progressColor(goal.percent) }"></div>
          </div>
        </div>

        <!-- 底部 -->
        <div class="flex items-center justify-between text-[11px]" style="color: var(--color-text-muted)">
          <div class="flex gap-3">
            <span v-if="goal.monthly_contribution">月投 {{ fmt(goal.monthly_contribution) }}</span>
            <span v-if="goal.estimated_completion">预计 {{ goal.estimated_completion }}</span>
          </div>
          <div v-if="goal.status === 'active'" class="flex gap-2">
            <button @click="handleStatus(goal, 'paused')" class="hover:text-amber-500">暂停</button>
            <button @click="handleStatus(goal, 'completed')" class="hover:text-emerald-500">完成</button>
          </div>
          <button v-else-if="goal.status === 'paused'" @click="handleStatus(goal, 'active')" class="hover:text-blue-500">恢复</button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="card text-center py-16">
      <p class="text-3xl mb-2">🎯</p>
      <p class="text-sm" style="color: var(--color-text-secondary)">还没有财务目标</p>
      <p class="text-xs mt-1" style="color: var(--color-text-muted)">设定一个开始追踪吧</p>
    </div>

    <!-- Modal -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-end md:items-center justify-center" @click.self="showForm = false">
        <div class="bg-white w-full md:w-[440px] md:rounded-xl rounded-t-xl max-h-[85vh] overflow-y-auto" style="border: 1px solid var(--color-border)">
          <div class="px-5 py-4 flex justify-between items-center" style="border-bottom: 1px solid var(--color-border-light)">
            <h2 class="text-sm font-semibold" style="color: var(--color-text-primary)">{{ editingId ? '编辑目标' : '新建目标' }}</h2>
            <button @click="showForm = false" class="text-lg" style="color: var(--color-text-muted)">&times;</button>
          </div>
          <div class="p-5 space-y-4">
            <!-- Icons -->
            <div class="flex gap-1.5 flex-wrap">
              <button v-for="ic in icons" :key="ic" @click="form.icon = ic"
                class="w-9 h-9 rounded-lg flex items-center justify-center text-lg transition"
                :style="form.icon === ic ? 'background: var(--color-primary-50); box-shadow: 0 0 0 2px var(--color-primary-400)' : 'background: var(--color-sidebar-bg)'"
              >{{ ic }}</button>
            </div>

            <div>
              <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">目标名称</label>
              <input v-model="form.name" type="text" placeholder="如：买房首付" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border); background: var(--color-card-bg)" />
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">类型</label>
                <select v-model="form.type" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)">
                  <option v-for="(label, key) in typeLabels" :key="key" :value="key">{{ label }}</option>
                </select>
              </div>
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">优先级</label>
                <input v-model.number="form.priority" type="number" min="1" max="10" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">目标金额 (元)</label>
                <input v-model.number="form.target_amount" type="number" min="0" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)" />
              </div>
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">当前进度 (元)</label>
                <input v-model.number="form.current_amount" type="number" min="0" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">每月投入 (元)</label>
                <input v-model.number="form.monthly_contribution" type="number" min="0" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)" />
              </div>
              <div>
                <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">截止日期</label>
                <input v-model="form.deadline" type="date" class="w-full mt-1 px-3 py-2 rounded-lg text-sm" style="border: 1px solid var(--color-border)" />
              </div>
            </div>

            <div>
              <label class="text-[11px] font-medium" style="color: var(--color-text-muted)">备注</label>
              <textarea v-model="form.note" rows="2" placeholder="可选" class="w-full mt-1 px-3 py-2 rounded-lg text-sm resize-none" style="border: 1px solid var(--color-border)"></textarea>
            </div>

            <button @click="handleSubmit" class="btn-primary w-full !py-2.5">{{ editingId ? '保存修改' : '创建目标' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
