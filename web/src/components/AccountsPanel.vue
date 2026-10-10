<script setup lang="ts">
/**
 * 账户（一个列表，两件事）
 *
 * 每行 = 图标 + 名称 + 类型（展开可改）+ **余额输入**。
 *
 * 为什么合并：以前资产页把同一批账户列了**两次**——一次「各账户余额」填数，
 * 一次「账户设置」改类型。同一个东西在一个页面出现两遍是纯冗余，
 * 也让人不确定该去哪一处改。这个项目一直在消除这类重复
 * （侧栏 vs「我的」、仪表 vs 页面），这里是同一类问题的最后一处。
 *
 * 保存是显式的（「保存」按钮），但**只在有改动时出现**：
 * 不写「记录今日」这种每日仪式措辞，也没有日期选择——记录就是记录，
 * 不需要先决定"记到哪一天"。这样也顺带消掉了「补录历史日期会把今天
 * 所有账户的值覆盖到过去」那个 bug（批量提交 + 日期 是它的温床）。
 *
 * 空值不是 0：清空输入框只是取消这次输入，不会把余额记成 0。
 */
import { ref, computed, onMounted, watch } from 'vue'
import api from '@/api'
import { useToast } from '@/composables/useToast'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{
  accounts: Array<{ id: number; name: string; asset_type: string; icon?: string }>
}>()
const emit = defineEmits<{ changed: [] }>()

const toast = useToast()

/** 资产类型 → 中文（与后端 asset_type 枚举一致） */
const TYPE_LABELS: Record<string, string> = {
  liquid: '活期', savings: '定期', investment: '理财投资', credit: '信用卡',
  loan: '贷款', property: '不动产', other: '其他',
}

interface Snap {
  cash: number
  isDebt: boolean
  hasHoldings: boolean
  lastUpdated: string
  staleDays: number | null
}

const loading = ref(true)
const saving = ref(false)
const snapByAccount = ref<Map<number, Snap>>(new Map())
const lastUpdated = ref<string | null>(null)
/** 每行输入框的当前文本。真相在 snapByAccount 里 */
const draft = ref<Record<number, string>>({})
/** 行内展开改设置的账户 */
const editing = ref<number | null>(null)
const editForm = ref<{ asset_type: string; credit_limit: number | null }>({ asset_type: 'liquid', credit_limit: null })

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/assets/portfolio')
    if (data.code === 0) {
      const map = new Map<number, Snap>()
      for (const a of data.data.accounts ?? []) {
        map.set(a.accountId, {
          cash: a.cash, isDebt: a.isDebt, hasHoldings: a.hasHoldings,
          lastUpdated: a.lastUpdated, staleDays: a.staleDays,
        })
      }
      snapByAccount.value = map
      lastUpdated.value = data.data.lastUpdated ?? null
      seedDraft()
    }
  } catch { toast.error('读取账户失败') } finally { loading.value = false }
}

/** 预填快照值（只在还没被用户改过时刷新，不覆盖正在输入的内容） */
function seedDraft() {
  const next = { ...draft.value }
  for (const acc of props.accounts) {
    const snap = snapByAccount.value.get(acc.id)
    const text = snap ? String(snap.cash / 100) : ''
    // 用户没动过这一行（或本来就没值）→ 用快照值刷新预填
    if (next[acc.id] === undefined || next[acc.id] === text || next[acc.id] === '') next[acc.id] = text
  }
  draft.value = next
}

watch(() => props.accounts, seedDraft, { immediate: true, deep: true })
onMounted(load)

const rows = computed(() =>
  props.accounts.map((acc) => {
    const snap = snapByAccount.value.get(acc.id)
    return {
      accountId: acc.id,
      name: acc.name,
      icon: acc.icon,
      assetType: acc.asset_type || 'liquid',
      isInvestment: acc.asset_type === 'investment',
      isDebt: snap?.isDebt ?? false,
      hasSnapshot: Boolean(snap),
      staleDays: snap?.staleDays ?? null,
    }
  }),
)

/** 有没有改动 —— 决定「保存」按不按钮出现 */
const dirty = computed(() =>
  rows.value.some((r) => {
    const text = String(draft.value[r.accountId] ?? '').trim()
    if (text === '') return false                       // 空 = 没填，不算改动
    const prev = snapByAccount.value.get(r.accountId)?.cash
    return prev == null || Math.round(Number(text) * 100) !== prev
  }),
)


async function save() {
  const items = rows.value
    .map((r) => {
      const text = String(draft.value[r.accountId] ?? '').trim()
      if (text === '') return null                      // 空不是 0，跳过
      const yuan = Number(text)
      if (!Number.isFinite(yuan)) { toast.warning(`${r.name} 的余额不是数字，已跳过`); return null }
      return { account_id: r.accountId, balance: Math.round(yuan * 100) }
    })
    .filter(Boolean) as Array<{ account_id: number; balance: number }>

  if (items.length === 0) { toast.warning('还没有填余额'); return }
  saving.value = true
  try {
    const { data } = await api.put('/assets/snapshots', { items })
    if (data.code === 0) {
      toast.success('已保存')
      await load()
      emit('changed')
    } else toast.error(data.message || '保存失败')
  } catch { toast.error('保存失败') } finally { saving.value = false }
}

/** 展开某账户的设置 */
function toggleEdit(r: { accountId: number; assetType: string }) {
  if (editing.value === r.accountId) { editing.value = null; return }
  editing.value = r.accountId
  editForm.value = { asset_type: r.assetType, credit_limit: null }
}

/** 改账户类型/额度 —— 只改元数据，不碰余额 */
async function saveEdit() {
  if (editing.value == null) return
  try {
    const payload: Record<string, unknown> = { asset_type: editForm.value.asset_type }
    if (editForm.value.credit_limit != null && editForm.value.asset_type === 'credit') {
      payload.credit_limit = Math.round(editForm.value.credit_limit * 100)
    }
    const { data } = await api.put(`/assets/accounts/${editing.value}`, payload)
    if (data.code === 0) {
      toast.success('已更新')
      editing.value = null
      emit('changed')          // 父页会重算读数 + 刷新侧栏的「投资」入口
    } else toast.error(data.message || '更新失败')
  } catch { toast.error('更新失败') }
}
</script>

<template>
  <section class="sheet acct">
    <header class="acct-head">
      <span class="ledger-label ledger-label-solid">账户</span>
      <span v-if="lastUpdated" class="acct-when amt">上次 {{ lastUpdated }}</span>
    </header>

    <p v-if="!loading && rows.length === 0" class="acct-empty">
      还没有账户。先去设置里添加账户。
    </p>

    <template v-else>
      <ul class="acct-list">
        <template v-for="a in rows" :key="a.accountId">
          <li class="acct-row">
            <span class="tx-icon" aria-hidden="true">{{ a.icon || '💳' }}</span>
            <span class="acct-id">
              <button class="acct-name" :title="`改「${a.name}」的类型`" @click="toggleEdit(a)">
                {{ a.name }}
                <span class="acct-type">{{ TYPE_LABELS[a.assetType] ?? a.assetType }}</span>
                <AppIcon :name="editing === a.accountId ? 'chevronUp' : 'chevronDown'" :size="12" class="acct-caret" />
              </button>
              <span v-if="a.isInvestment" class="acct-tag">余额填现金</span>
              <span v-else-if="a.staleDays !== null && a.staleDays >= 3" class="acct-stale amt">{{ a.staleDays }} 天没更新</span>
            </span>
            <input
              v-model="draft[a.accountId]"
              class="acct-input amt"
              type="number"
              inputmode="decimal"
              step="0.01"
              placeholder="0"
              :aria-label="`${a.name} 余额`"
            />
          </li>

          <!-- 行内改设置：只改元数据，余额在上面那行 -->
          <li v-if="editing === a.accountId" class="acct-edit">
            <label>
              <span>账户类型</span>
              <select v-model="editForm.asset_type" class="field">
                <option v-for="(label, key) in TYPE_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
            <label v-if="editForm.asset_type === 'credit'">
              <span>额度（元）</span>
              <input v-model.number="editForm.credit_limit" class="field amt" type="number" step="0.01" />
            </label>
            <div class="acct-edit-ops">
              <button class="btn btn-quiet btn-sm" @click="editing = null">取消</button>
              <button class="btn btn-primary btn-sm" @click="saveEdit">保存类型</button>
            </div>
          </li>
        </template>
      </ul>

      <!-- 有改动才出现。不写「记录今日」——记录就是记录，不用先决定记到哪天 -->
      <footer v-if="dirty" class="acct-foot">
        <span class="acct-foot-note">有未保存的余额</span>
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.acct-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  border-bottom: 1px solid var(--color-rule);
}
.acct-when { font-size: 0.6875rem; color: var(--color-ink-3); }
.acct-empty { padding: 1rem 0.875rem; font-size: 0.8125rem; color: var(--color-ink-3); }
.acct-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.875rem;
  border-top: 1px solid var(--color-rule-faint);
}
.acct-list > .acct-row:first-child { border-top: 0; }
.acct-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.0625rem; }
.acct-name {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: var(--color-ink-1);
  text-align: left;
  min-width: 0;
}
.acct-name:hover { color: var(--color-action); }
.acct-type { font-size: 0.625rem; color: var(--color-ink-3); }
.acct-caret { color: var(--color-ink-4); }
.acct-tag { font-size: 0.5625rem; color: var(--color-ink-4); }
.acct-stale { font-size: 0.5625rem; color: var(--color-warn); }
.acct-input {
  width: 7.5rem;
  height: 1.875rem;
  padding: 0 0.5rem;
  text-align: right;
  font-size: 0.8125rem;
  color: var(--color-ink-1);
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}
.acct-input:focus {
  outline: none;
  border-color: var(--color-action);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-action) 14%, transparent);
}
.acct-edit {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem 0.75rem;
  background: var(--color-paper-sunk);
  border-top: 1px solid var(--color-rule-faint);
}
.acct-edit label { display: flex; flex-direction: column; gap: 0.25rem; }
.acct-edit label > span { font-size: 0.625rem; color: var(--color-ink-3); }
.acct-edit-ops { margin-left: auto; display: flex; gap: 0.375rem; }
.acct-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  border-top: 1px solid var(--color-rule);
  background: var(--color-paper-sunk);
}
.acct-foot-note { font-size: 0.625rem; color: var(--color-ink-3); }
</style>
