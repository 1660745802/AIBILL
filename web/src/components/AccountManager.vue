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
  { v: 'liquid',     label: '活期',     icon: '💳', hint: '随时能花的钱' },
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
function typeLabel(t?: string): string {
  return ASSET_TYPES.find((x) => x.v === (t || 'liquid'))?.label || '活期'
}

/** 活跃账户余额合计：负数是欠款，正数是净资产 */
const activeTotal = computed(
  () => active.value.reduce((s, a) => s + (a.current_balance ?? a.initial_balance ?? 0), 0),
)
</script>
<template>
  <div class="sheet">
    <!-- 头部：账户 + 合计。合计是这个页面唯一需要一眼看到的东西 -->
    <div class="am-head">
      <span class="am-title">账户</span>
      <div class="am-head-right">
        <span class="am-total amt">
          <Money :value="activeTotal" size="sm" :tone="activeTotal < 0 ? 'expense' : 'muted'" sign="none" />
        </span>
        <button @click="showAdd = !showAdd" class="btn btn-quiet btn-sm">
          {{ showAdd ? '取消' : '+ 添加' }}
        </button>
      </div>
    </div>

    <!-- 添加：名称 / 类型 / 余额一次给全，不用建完再去别处改一遍 -->
    <div v-if="showAdd" class="am-form bg-paper-sunk border-b border-rule-faint">
      <!-- 标签固定写在上方：placeholder 一有内容就消失，
           用户会看到一个不知道是什么的空白框 -->
      <div>
        <div class="am-label">图标 / 账户名称</div>
        <div class="flex gap-2">
          <input
            v-model="newIcon" class="field w-12 text-center" maxlength="4"
            aria-label="图标" @input="newIconTouched = true"
          />
          <input
            v-model="newName" class="field flex-1" placeholder="如「招行卡」「券商账户」"
            aria-label="账户名称" @keydown.enter="addAccount"
          />
        </div>
      </div>

      <!-- 类型用一排可点的标签，不是下拉：下拉里翻不到「理财投资」，
           而那恰恰是最需要新建的那种账户 -->
      <div>
        <div class="am-label">账户类型</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="t in ASSET_TYPES" :key="t.v" type="button"
            class="chip" :class="newType === t.v ? 'chip-active' : ''"
            @click="pickType(t.v)"
          >{{ t.label }}</button>
        </div>
        <p v-if="newTypeMeta.hint" class="am-hint">
          {{ newTypeMeta.hint }}<template v-if="newType === 'investment'"> · 添加后到「投资」页配持仓</template>
        </p>
      </div>

      <div>
        <div class="am-label">当前余额（选填，不想填就是 0）</div>
        <div class="flex gap-2">
          <input
            v-model="newBalance" type="number" step="0.01" inputmode="decimal"
            class="field flex-1 amt" placeholder="0.00" aria-label="当前余额"
            @keydown.enter="addAccount"
          />
          <button @click="addAccount" :disabled="loading || !newName.trim()" class="btn btn-primary btn-sm">
            添加
          </button>
        </div>
      </div>
    </div>

    <!-- 账户列表：名称在左、余额在右（一眼扫完），类型作副标签 -->
    <template v-for="acc in active" :key="acc.id">
      <div
        class="sheet-row sheet-row-click"
        :class="editingId === acc.id ? 'sheet-row-active' : ''"
        role="button" tabindex="0"
        @click="startEdit(acc)" @keydown.enter="startEdit(acc)"
      >
        <span class="tx-icon">{{ acc.icon }}</span>
        <div class="am-row-main">
          <span class="am-row-name">{{ acc.name }}</span>
          <span class="am-row-type">{{ typeLabel(acc.asset_type) }}</span>
        </div>
        <Money
          class="am-row-amt"
          :value="acc.current_balance ?? acc.initial_balance"
          size="md" :tone="(acc.current_balance ?? acc.initial_balance) < 0 ? 'expense' : 'neutral'"
          sign="none"
        />
        <AppIcon :name="editingId === acc.id ? 'chevronUp' : 'chevronDown'" :size="15" class="am-chev text-ink-4" />
      </div>

      <!-- 展开 = 编辑态。删除收在这里，不常驻在每一行（减少误触和视觉噪音） -->
      <div v-if="editingId === acc.id" class="am-edit bg-paper-sunk border-t border-rule-faint">
        <div>
          <div class="am-label">图标 / 账户名称</div>
          <div class="flex gap-2">
            <input v-model="editIcon" class="field w-12 text-center" maxlength="4" aria-label="图标" />
            <input v-model="editName" class="field flex-1" placeholder="账户名称" aria-label="账户名称" />
          </div>
        </div>
        <div>
          <div class="am-label">账户类型</div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="t in ASSET_TYPES" :key="t.v" type="button"
              class="chip" :class="editType === t.v ? 'chip-active' : ''"
              @click="editType = t.v"
            >{{ t.label }}</button>
          </div>
        </div>
        <div>
          <div class="am-label">当前余额（元）</div>
          <input
            v-model="editBalance" type="number" step="0.01" inputmode="decimal"
            class="field am-input amt" placeholder="0.00" aria-label="当前余额"
          />
        </div>
        <div class="am-edit-ops">
          <button @click.stop="pendingDelete = acc" class="btn btn-quiet btn-sm am-del">删除这个账户</button>
          <span class="flex-1" />
          <button @click.stop="editingId = null" class="btn btn-quiet btn-sm">取消</button>
          <button @click.stop="saveEdit" class="btn btn-primary btn-sm">保存</button>
        </div>
      </div>
    </template>

    <div v-if="!active.length" class="am-empty">还没有账户，点右上角「+ 添加」新建一个。</div>

    <!--
      已删除：默认收起来。它是「找回头」用的，不该常年占版面。

      在父布局里的位置：贴在列表底部、**右对齐、不占整行**。
      做成全宽条会让它看起来和账户行是平级的，抢主内容的注意力；
      而它其实是三级信息（主 = 账户列表，次 = 添加，三级 = 已删除）。
    -->
    <div v-if="removed.length" class="am-fold">
      <div class="am-fold-bar">
        <button
          class="am-fold-btn" type="button" :aria-expanded="showRemoved"
          @click="showRemoved = !showRemoved"
        >
          <AppIcon :name="showRemoved ? 'chevronDown' : 'chevronRight'" :size="11" />
          <span>已删除 {{ removed.length }}</span>
        </button>
      </div>
      <template v-if="showRemoved">
        <div v-for="acc in removed" :key="acc.id" class="sheet-row am-removed-row">
          <span class="tx-icon">{{ acc.icon }}</span>
          <span class="am-row-name line-through text-ink-4 truncate">{{ acc.name }}</span>
          <span class="flex-1" />
          <button @click.stop="restore(acc)" class="act">还原</button>
        </div>
      </template>
    </div>
  </div>

  <!-- 删除确认：如实说明账单会怎样（用户原话「账单没漏就行」） -->
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
</template>

<style scoped>
.am-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--color-rule-faint);
}
.am-title { font-size: 0.75rem; font-weight: 600; color: var(--color-ink-2); }
.am-head-right { display: flex; align-items: center; gap: 0.5rem; }
.am-total { color: var(--color-ink-3); }

.am-form, .am-edit { padding: 0.75rem 0.875rem; display: flex; flex-direction: column; gap: 0.75rem; }
.am-label { font-size: 0.6875rem; color: var(--color-ink-3); margin-bottom: 0.3rem; }
.am-hint { font-size: 0.6875rem; color: var(--color-ink-4); margin-top: 0.3rem; }
.am-input { width: 100%; text-align: right; }

.am-row-main { display: flex; align-items: baseline; gap: 0.375rem; min-width: 0; flex: 1; }
.am-row-name {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-ink-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-row-type { font-size: 0.625rem; color: var(--color-ink-4); white-space: nowrap; }
.am-row-amt { flex-shrink: 0; }
.am-chev { flex-shrink: 0; }

.am-edit-ops { display: flex; align-items: center; gap: 0.5rem; }
.am-del { color: var(--color-danger, var(--color-expense)); }

.am-empty { padding: 1.5rem 0.875rem; text-align: center; font-size: 0.75rem; color: var(--color-ink-4); }

.am-fold {
  border-top: 1px solid var(--color-rule-faint);
  padding-bottom: 0.125rem;
}
/* 页脚控件：右对齐、内嵌、不占整行——和账户行拉开层级 */
.am-fold-bar {
  display: flex;
  justify-content: flex-end;
  padding: 0.375rem 0.5rem;
}
.am-fold-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  background: none;
  border: 0;
  color: var(--color-ink-4);
  font-size: 0.625rem;
  letter-spacing: 0.01em;
  cursor: pointer;
  border-radius: var(--radius-xs);
}
.am-fold-btn:hover { color: var(--color-ink-2); background: var(--color-paper-sunk); }
.am-fold-btn:focus-visible { outline: 2px solid var(--color-action); outline-offset: 1px; }
.am-removed-row { opacity: 0.6; }
</style>
