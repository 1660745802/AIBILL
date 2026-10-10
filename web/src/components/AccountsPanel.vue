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
import Money from '@/components/ui/Money.vue'

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
  /** 账户总价值 = 持仓市值 + 现金。持仓行情缺失时为 null（此时只算现金，净资产显示 ≥） */
  value: number | null
  /** 持仓市值（折人民币）。无持仓为 0，行情缺失为 null */
  holdingsValue: number | null
  isDebt: boolean
  hasHoldings: boolean
  lastUpdated: string
  staleDays: number | null
}

const loading = ref(true)
const saving = ref(false)
const snapByAccount = ref<Map<number, Snap>>(new Map())
const lastUpdated = ref<string | null>(null)
/** 合计 = 仪表盘的净资产口径（Σ 总价值），不是「现金加起来」 */
const netWorth = ref<number | null>(null)
const netWorthComplete = ref(true)
const unpriced = ref(0)
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
          cash: a.cash, value: a.value ?? null, holdingsValue: a.holdingsValue ?? null,
          isDebt: a.isDebt, hasHoldings: a.hasHoldings,
          lastUpdated: a.lastUpdated, staleDays: a.staleDays,
        })
      }
      snapByAccount.value = map
      lastUpdated.value = data.data.lastUpdated ?? null
      netWorth.value = data.data.netWorth ?? null
      netWorthComplete.value = data.data.netWorthComplete !== false
      unpriced.value = data.data.unpricedAccounts ?? 0
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
      cash: snap?.cash ?? 0,
      // **总价值**（现金 + 持仓市值）。仪表盘的净资产按这个口径累加，
      // 这里也按它显示，账户行加起来才等于净资产——之前只显示现金，
      // 理财账户的持仓市值漏在外面，数字对不上仪表盘。
      value: snap?.value ?? null,
      holdingsValue: snap?.holdingsValue ?? null,
      hasHoldings: snap?.hasHoldings ?? false,
      /** 持仓市值没取到价 → 总价值算不出，只能显示现金这个下限 */
      valueUnknown: snap?.hasHoldings === true && (snap?.value ?? null) == null,
    }
  }),
)

/** 元 → 「¥1,234.56」。行内小字用它，别再出现裸的 `12` */
function fmt(cents: number): string {
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 保存**单行**的现金（改完这一行就生效）。
 *
 * 以前是「页面上所有输入框 + 一个保存按钮」，现在主数字是只读的总价值、
 * 输入收进行内展开，所以一行一存——离开输入框即提交，不用找保存按钮。
 *
 * 只提交这一行、且只提交真正改动的值：提交整页会把「打开时的旧值」也发上去，
 * 期间（另一台设备）记的账会被覆盖回去。
 */
async function save(row: { accountId: number; name: string }) {
  const text = String(draft.value[row.accountId] ?? '').trim()
  if (text === '') {                                  // 空 = 取消输入，不是 0
    seedDraft()
    return
  }
  const yuan = Number(text)
  if (!Number.isFinite(yuan) || yuan < 0) {
    toast.warning(`${row.name} 的现金不是数字，已还原`)
    seedDraft()
    return
  }
  const next = Math.round(yuan * 100)
  const prev = snapByAccount.value.get(row.accountId)?.cash
  if (prev != null && next === prev) return            // 没改动，不打扰

  saving.value = true
  try {
    const { data } = await api.put('/assets/snapshots', {
      items: [{ account_id: row.accountId, balance: next }],
    })
    if (data.code === 0) {
      toast.success(`「${row.name}」现金已更新`)
      await load()
      emit('changed')
    } else toast.error(data.message || '保存失败')
  } catch { toast.error('保存失败') }
  finally { saving.value = false }
}

/** 展开/收起某行的编辑区（现金 + 账户类型） */
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
      <!-- 合计放在这里，而且**必须和仪表盘净资产同口径**（Σ 总价值）。
           之前这一页只显示现金、加起来和仪表盘差一个持仓市值，用户会以为算错了。 -->
      <span v-if="netWorth != null" class="acct-sum">
        <span class="acct-sum-cap">合计</span>
        <span v-if="!netWorthComplete" class="acct-ge">≥</span
        ><Money :value="netWorth" size="md" :tone="netWorth < 0 ? 'expense' : 'neutral'" sign="none" />
        <span v-if="!netWorthComplete" class="acct-sum-note">{{ unpriced }} 个持仓未取价</span>
      </span>
      <span v-else-if="lastUpdated" class="acct-when amt">上次 {{ lastUpdated }}</span>
    </header>

    <p v-if="!loading && rows.length === 0" class="acct-empty">
      还没有账户。先去设置里添加账户。
    </p>

    <template v-else>
      <ul class="acct-list">
        <template v-for="a in rows" :key="a.accountId">
          <li class="acct-row">
            <span class="tx-icon" aria-hidden="true">{{ a.icon || '💳' }}</span>
            <button class="acct-id acct-id-btn" @click="toggleEdit(a)">
              <span class="acct-name">
                {{ a.name }}
                <span class="acct-type">{{ TYPE_LABELS[a.assetType] ?? a.assetType }}</span>
              </span>
              <!-- 构成写清楚：这个数为什么是这么大 -->
              <span v-if="a.hasHoldings" class="acct-break">
                <template v-if="a.valueUnknown">
                  现金 {{ fmt(a.cash) }} · 持仓未取价
                </template>
                <template v-else>
                  持仓 {{ fmt(a.holdingsValue ?? 0) }} · 现金 {{ fmt(a.cash) }}
                </template>
              </span>
              <span v-else-if="a.staleDays !== null && a.staleDays >= 3" class="acct-stale amt">
                {{ a.staleDays }} 天没更新
              </span>
            </button>
            <!--
              主数字 = **账户总价值**（现金 + 持仓市值），和仪表盘净资产同口径。
              之前这里是个现金输入框：扫视时看不出这个账户有多少钱，
              而且把各行加起来会和仪表盘差一个持仓市值。
            -->
            <span class="acct-total amt">
              <span v-if="a.valueUnknown" class="acct-ge">≥</span
              ><Money
                :value="a.value ?? a.cash"
                size="md"
                :tone="(a.value ?? a.cash) < 0 ? 'expense' : 'neutral'"
                sign="none"
              />
            </span>
          </li>

          <!-- 行内改设置：只改元数据，余额在上面那行 -->
          <li v-if="editing === a.accountId" class="acct-edit">
            <!--
              现金输入收在这里。理财账户的 `balance` 语义是**现金**
              （总价值 = 现金 + 持仓市值），所以叫「现金」不叫「余额」。

              原来标签后面还缀着「· 持仓市值 355,901.70 自动算」——上面那行已经
              写了「持仓 ¥355,901.70 · 现金 ¥0.00」的构成，重复一遍反而挤歪布局。
            -->
            <div class="acct-edit-fields">
              <label>
                <span>现金（元）</span>
                <input
                  v-model="draft[a.accountId]"
                  class="field amt acct-cash"
                  type="number"
                  inputmode="decimal"
                  step="0.01"
                  placeholder="0.00"
                  :aria-label="`${a.name} 现金`"
                  @change="save(a)"
                />
              </label>
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
            </div>
            <div class="acct-edit-ops">
              <button class="btn btn-quiet btn-sm" @click="editing = null">取消</button>
              <button class="btn btn-primary btn-sm" @click="saveEdit">保存类型</button>
            </div>
          </li>
        </template>
      </ul>

    </template>
  </section>
</template>

<style scoped>
/* 合计（和仪表盘净资产同口径） */
.acct-sum {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
}
.acct-sum-cap { font-size: 0.625rem; color: var(--color-ink-4); }
.acct-sum-note { font-size: 0.5625rem; color: var(--color-ink-4); }

/* 行：左侧身份+构成，右侧总价值。整行可点开编辑。 */
.acct-id-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  min-width: 0;
  flex: 1;
  background: none;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.acct-id-btn:hover .acct-name { color: var(--color-action); }
.acct-break {
  font-size: 0.5625rem;
  line-height: 1.4;
  color: var(--color-ink-4);
  font-variant-numeric: tabular-nums;
}
.acct-total {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 0.1rem;
}
.acct-ge { color: var(--color-ink-3); font-weight: 500; }

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
.acct-edit { align-items: flex-end; }
/* 字段用同一套网格：同高、标签基线对齐。
   之前是两个 flex 容器各自按内容撑开，输入框窄、下拉框宽，高度和基线都对不上。

   比例是定死的而不是均分：现金是个数字，用窄框；类型是词，用中框；
   信用卡额度出现时占剩下的宽。均分会让「0」独占半屏。 */
.acct-edit-fields {
  display: grid;
  grid-template-columns: minmax(7rem, 9rem) minmax(9rem, 12rem) minmax(0, 1fr);
  gap: 0.625rem;
  align-items: end;
  flex: 1;
  min-width: 0;
}
.acct-edit-fields label { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.acct-edit-fields label > span {
  font-size: 0.5625rem;
  line-height: 1;
  color: var(--color-ink-4);
  letter-spacing: 0.02em;
  margin-bottom: 0.25rem;
  white-space: nowrap;
}
/* 输入框和下拉走同一套尺寸，否则一个高一截 */
.acct-edit-fields .field { width: 100%; }
.acct-cash { text-align: right; }
.acct-edit-ops { display: flex; gap: 0.375rem; flex-shrink: 0; }
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
