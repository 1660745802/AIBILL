<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import api from '@/api/index'
import Money from '@/components/ui/Money.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const accounts = ref<any[]>([])
const showAdd = ref(false)
const loading = ref(false)

/* 账户类型（这是**账户种类**，不是付款渠道）。
   之前这里只有微信/支付宝/银行卡/现金/信用卡——那是渠道，而且没有「理财投资」，
   于是新建一个证券账户只能建成活期，再去资产页展开行里改类型，
   同一个设置两个入口、第二个藏得最深。现在一次建对。 */
const ASSET_TYPES = [
  { v: 'liquid',     label: '活期',     icon: '💳', hint: '随时能花的��' },
  { v: 'savings',    label: '定期',     icon: '🏦', hint: '有期限的存款' },
  { v: 'investment', label: '理财投资', icon: '📈', hint: '券商/基金，可挂持仓' },
  { v: 'credit',     label: '信用卡',   icon: '💳', hint: '欠款算负债' },
  { v: 'loan',       label: '贷款',     icon: '📄', hint: '房贷车贷' },
  { v: 'property',   label: '不动产',   icon: '🏠', hint: '房产等大额' },
  { v: 'other',      label: '其他',     icon: '📦', hint: '' },
] as const

const newName = ref('')
const newType = ref<string>('liquid')
const newIcon = ref('💳')
const newIconTouched = ref(false)
const newBalance = ref('')

const newTypeMeta = computed(() => ASSET_TYPES.find((t) => t.v === newType.value) ?? ASSET_TYPES[0])

/** 选类型就换图标，除非用户自己改过——不用猜该填什么 emoji */
function pickType(v: string) {
  newType.value = v
  if (!newIconTouched.value) {
    const t = ASSET_TYPES.find((x) => x.v === v)
    if (t) newIcon.value = t.icon
  }
}

onMounted(() => fetchAccounts())

async function fetchAccounts() {
  try {
    const { data } = await api.get('/accounts', { params: { include_inactive: '1' } })
    if (data.code === 0) accounts.value = data.data.items
  } catch { /* ignore */ }
}

const active = computed(() => accounts.value.filter((a) => a.is_active))
const removed = computed(() => accounts.value.filter((a) => !a.is_active))

async function addAccount() {
  if (!newName.value.trim()) return
  loading.value = true
  try {
    const balance = newBalance.value ? Math.round(parseFloat(newBalance.value) * 100) : 0
    const { data } = await api.post('/accounts', {
      name: newName.value.trim(),
      // type 是历史遗留的渠道字段，只影响旧客户端的分组；新界面按 asset_type 分
      type: 'other',
      icon: newIcon.value,
      asset_type: newType.value,
      // 初始余额同时写进 balance：不然建完在资产页看不到，还得再手填一次
      initial_balance: balance,
    })
    if (data.code !== 0) { toast.error(data.message || '创建失败'); return }
    newName.value = ''
    newBalance.value = ''
    newIconTouched.value = false
    newType.value = 'liquid'
    newIcon.value = '💳'
    showAdd.value = false
    await fetchAccounts()
    toast.success(`已添加「${data.data.name}」`)
  } catch { toast.error('创建失败') }
  finally { loading.value = false }
}

/* 账户是「有」或「没有」，不是「启用/停用」两个中间态。
   删除 = 移出列表；账单保留但不再计入余额（服务端就是这么做的）。 */
const pendingDelete = ref<any | null>(null)
// 已删除默认收起来：它是"找回头"用的，不该常年占着版面
const showRemoved = ref(false)

async function confirmDelete() {
  const acc = pendingDelete.value
  if (!acc) return
  loading.value = true
  try {
    const { data } = await api.delete(`/accounts/${acc.id}`)
    if (data.code !== 0) { toast.error(data.message || '删除失败'); return }
    toast.success(data.message || '已删除')
    pendingDelete.value = null
    await fetchAccounts()
  } catch { toast.error('删除失败') }
  finally { loading.value = false }
}

async function restore(acc: any) {
  try {
    const { data } = await api.post(`/accounts/${acc.id}/restore`)
    if (data.code !== 0) { toast.error(data.message || '还原失败'); return }
    await fetchAccounts()
    toast.success('已还原')
  } catch { toast.error('还原失败') }
}

// 行内展开编辑
const editingId = ref<number | null>(null)
const editName = ref('')
const editIcon = ref('')
const editBalance = ref('')
const editType = ref<string>('liquid')

function startEdit(acc: any) {
  if (editingId.value === acc.id) { editingId.value = null; return }
  editingId.value = acc.id
  editName.value = acc.name
  editIcon.value = acc.icon
  editBalance.value = ((acc.current_balance ?? acc.initial_balance) / 100).toString()
  editType.value = acc.asset_type || 'liquid'
}

async function saveEdit() {
  if (!editingId.value || !editName.value.trim()) return
  try {
    const balance = Math.round(parseFloat(editBalance.value || '0') * 100)
    const { data } = await api.put(`/accounts/${editingId.value}`, {
      name: editName.value.trim(),
      icon: editIcon.value,
      asset_type: editType.value,
      current_balance: balance,
    })
    if (data.code !== 0) { toast.error(data.message || '保存失败'); return }
    editingId.value = null
    await fetchAccounts()
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="sheet">
    <!-- 头部 -->
    <div class="flex items-center justify-between px-3.5 py-2.5 border-b border-rule-faint">
      <span class="text-xs font-semibold text-ink-2">账户</span>
      <button @click="showAdd = !showAdd" class="act">
        {{ showAdd ? '取消' : '+ 添加' }}
      </button>
    </div>

    <!-- 添加：名称 / 类型 / 余额一次给全，不用建完再去别处改一遍 -->
    <div v-if="showAdd" class="px-3.5 py-3 bg-paper-sunk border-b border-rule-faint space-y-2.5">
      <!-- 标签写在上面而不是用 placeholder：placeholder 一有内容就消失，
           编辑时预填了名称，用户会看到一个光秃秃的框，不知道是干什么的。 -->
      <div>
        <div class="mb-1.5 text-[11px] text-ink-3">图标 / 账户名称</div>
        <div class="flex gap-2">
          <input
            v-model="newIcon"
            class="field w-12 text-center"
            maxlength="4"
            aria-label="图标"
            @input="newIconTouched = true"
          />
          <input
            v-model="newName"
            class="field flex-1"
            placeholder="如「招行卡」「券商账户」"
            aria-label="账户名称"
            @keydown.enter="addAccount"
          />
        </div>
      </div>

      <!-- 类型用一排可点的标签，而不是下拉：下拉里翻不到「理财投资」，
           而那恰恰是最需要新建的那种账户 -->
      <div>
        <div class="mb-1.5 text-[11px] text-ink-3">账户类型</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="t in ASSET_TYPES"
            :key="t.v"
            type="button"
            class="chip"
            :class="newType === t.v ? 'chip-active' : ''"
            @click="pickType(t.v)"
          >{{ t.label }}</button>
        </div>
        <p v-if="newTypeMeta.hint" class="mt-1.5 text-[11px] text-ink-4">
          {{ newTypeMeta.hint }}
          <template v-if="newType === 'investment'">· 添加后到「投资」页配持仓
<style scoped>
.removed-fold {
  border-top: 1px solid var(--color-rule-faint);
}
.removed-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.55rem 0.875rem;
  background: none;
  border: 0;
  color: var(--color-ink-3);
  font-size: 0.6875rem;
  cursor: pointer;
  text-align: left;
}
.removed-toggle:hover { color: var(--color-ink-2); background: var(--color-paper-sunk); }
.removed-hint { margin-left: auto; color: var(--color-ink-4); font-size: 0.625rem; }
</style>
</template>
        </p>
      </div>

      <div class="flex gap-2">
        <input
          v-model="newBalance"
          type="number"
          step="0.01"
          inputmode="decimal"
          class="field flex-1 amt"
          placeholder="当前余额（选填，不想填就是 0）"
          aria-label="当前余额"
          @keydown.enter="addAccount"
        />
        <button @click="addAccount" :disabled="loading || !newName.trim()" class="btn btn-primary btn-sm">
          添加
        </button>
      </div>
    </div>

    <!-- 账户列表 -->
    <template v-for="acc in active" :key="acc.id">
      <div
        class="sheet-row sheet-row-click"
        :class="editingId === acc.id ? 'sheet-row-active' : ''"
        role="button"
        tabindex="0"
        @click="startEdit(acc)"
        @keydown.enter="startEdit(acc)"
      >
        <span class="tx-icon">{{ acc.icon }}</span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-ink-1 truncate">{{ acc.name }}</div>
          <div class="text-[11px] text-ink-3">
            <Money :value="acc.current_balance ?? acc.initial_balance" size="sm" :tone="(acc.current_balance ?? acc.initial_balance) < 0 ? 'expense' : 'muted'" />
            <span class="mx-1 text-ink-4">·</span>
            <span>{{ ASSET_TYPES.find((t) => t.v === (acc.asset_type || 'liquid'))?.label || '活期' }}</span>
          </div>
        </div>
        <button
          @click.stop="pendingDelete = acc"
          class="act shrink-0 act-danger"
          :aria-label="`删除 ${acc.name}`"
        >删除</button>
        <AppIcon :name="editingId === acc.id ? 'chevronUp' : 'chevronDown'" :size="15" class="text-ink-4 shrink-0" />
      </div>

      <!-- 行内展开编辑：类型也在行上，不藏进另一个页面 -->
      <div v-if="editingId === acc.id" class="px-3.5 py-3 bg-paper-sunk border-t border-rule-faint space-y-2.5">
        <!-- 同样用固定标签：这里输入框预填了现有名称，placeholder 会消失 -->
        <div>
          <div class="mb-1.5 text-[11px] text-ink-3">图标 / 账户名称</div>
          <div class="flex gap-2">
            <input v-model="editIcon" class="field w-12 text-center" maxlength="4" aria-label="图标" />
            <input v-model="editName" class="field flex-1" aria-label="账户名称" />
          </div>
        </div>
        <div>
          <div class="mb-1.5 text-[11px] text-ink-3">账户类型</div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="t in ASSET_TYPES"
              :key="t.v"
              type="button"
              class="chip"
              :class="editType === t.v ? 'chip-active' : ''"
              @click="editType = t.v"
            >{{ t.label }}</button>
          </div>
        </div>
        <div class="flex gap-2">
          <input
            v-model="editBalance"
            type="number"
            step="0.01"
            inputmode="decimal"
            class="field flex-1 amt"
            placeholder="当前余额（元）"
            aria-label="当前余额"
          />
          <button @click.stop="editingId = null" class="btn btn-quiet btn-sm">取消</button>
          <button @click.stop="saveEdit" class="btn btn-primary btn-sm">保存</button>
        </div>
      </div>
    
<style scoped>
.removed-fold {
  border-top: 1px solid var(--color-rule-faint);
}
.removed-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.55rem 0.875rem;
  background: none;
  border: 0;
  color: var(--color-ink-3);
  font-size: 0.6875rem;
  cursor: pointer;
  text-align: left;
}
.removed-toggle:hover { color: var(--color-ink-2); background: var(--color-paper-sunk); }
.removed-hint { margin-left: auto; color: var(--color-ink-4); font-size: 0.625rem; }
</style>
</template>

    <div v-if="!active.length" class="px-3.5 py-6 text-center text-xs text-ink-4">
      还没有账户，点右上角「+ 添加」新建一个。
    </div>

    <!-- 已删除：可以还原。**默认收起**——它是"找回头"用的，不该常年占版面。
         折叠条上直接给数量，想看再点开。 -->
    <div v-if="removed.length" class="removed-fold">
      <button
        class="removed-toggle"
        type="button"
        :aria-expanded="showRemoved"
        @click="showRemoved = !showRemoved"
      >
        <AppIcon :name="showRemoved ? 'chevronDown' : 'chevronRight'" :size="13" class="text-ink-4" />
        <span>已删除 {{ removed.length }} 个</span>
        <span class="removed-hint">{{ showRemoved ? '点行里的「还原」放回来' : '点开可还原' }}</span>
      </button>
      <template v-if="showRemoved">
        <div v-for="acc in removed" :key="acc.id" class="sheet-row opacity-50">
          <span class="tx-icon">{{ acc.icon }}</span>
          <div class="min-w-0 flex-1">
            <div class="text-sm text-ink-3 truncate line-through">{{ acc.name }}</div>
          </div>
          <button @click.stop="restore(acc)" class="act shrink-0">还原</button>
        </div>
      
<style scoped>
.removed-fold {
  border-top: 1px solid var(--color-rule-faint);
}
.removed-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.55rem 0.875rem;
  background: none;
  border: 0;
  color: var(--color-ink-3);
  font-size: 0.6875rem;
  cursor: pointer;
  text-align: left;
}
.removed-toggle:hover { color: var(--color-ink-2); background: var(--color-paper-sunk); }
.removed-hint { margin-left: auto; color: var(--color-ink-4); font-size: 0.625rem; }
</style>
</template>
    </div>
  </div>

  <!-- 删除确认：说清楚账单会怎样。用户明确过「账单没漏就行」，
       所以这里如实告知「账单保留但不再计入余额」，而不是静默删掉。 -->
  <div v-if="pendingDelete" class="fixed inset-0 z-50 flex items-center justify-center p-6" @click.self="pendingDelete = null">
    <div class="sheet w-full max-w-xs p-4">
      <div class="text-sm font-medium text-ink-1 mb-1.5">删除「{{ pendingDelete.name }}」？</div>
      <p class="text-[11px] text-ink-3 leading-relaxed mb-3">
        账户会从列表里消失，已经记在它名下的<strong>账单会全部保留</strong>，
        只是不再计入这个账户的余额。删错了可以在下方「已删除」里还原。
      </p>
      <div class="flex gap-2 justify-end">
        <button @click="pendingDelete = null" class="btn btn-quiet btn-sm">取消</button>
        <button @click="confirmDelete" class="btn btn-primary btn-sm">删除</button>
      </div>
    </div>
  </div>

<style scoped>
.removed-fold {
  border-top: 1px solid var(--color-rule-faint);
}
.removed-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.55rem 0.875rem;
  background: none;
  border: 0;
  color: var(--color-ink-3);
  font-size: 0.6875rem;
  cursor: pointer;
  text-align: left;
}
.removed-toggle:hover { color: var(--color-ink-2); background: var(--color-paper-sunk); }
.removed-hint { margin-left: auto; color: var(--color-ink-4); font-size: 0.625rem; }
</style>
</template>
