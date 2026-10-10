<script setup lang="ts">
/**
 * 投资（明细）
 *
 * 信息架构是「资产 = 汇总 / 投资 = 明细」两层：
 *   资产页每个账户只给一个数；持仓明细在这里，按理财账户分段。
 *   这样有 20 只股票时资产页也不会被撑爆。
 *
 * 口径（用户原话）：
 *   账户总价值 = 股数×单价 + 余额
 *   浮动盈亏   = 账户总价值 − 总投入
 *   投入只在账户级（「不要针对单只持仓股」）
 *
 * 这里能完成三件事，不需要跳去别的页：
 *   ① 配持仓（代码 + 股数）
 *   ② 填总投入（账户级，只在存/取钱时改）
 *   ③ 记现金（写今天的快照，和资产页的「各账户余额」是同一份数据）
 *
 * 「未配置 / 未取到价 / 记过余额」三种算不出的状态一律显示原因，不显示 0 或假负数。
 */
import { ref, computed, onMounted } from 'vue'
import api from '@/api'
import { useToast } from '@/composables/useToast'
import { useClusterStore } from '@/stores/cluster'
import PageHeader from '@/components/ui/PageHeader.vue'
import Money from '@/components/ui/Money.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import HoldingsEditor from '@/components/HoldingsEditor.vue'

const toast = useToast()
const cluster = useClusterStore()

interface Account {
  id: number
  name: string
  icon?: string
  asset_type: string
  invested_total: number | null
}
interface Position {
  accountId: number
  cash: number
  holdingsValue: number | null
  value: number | null
  totalInvested: number | null
  unrealized: number | null
  unrealizedRate: number | null
  holdingsPending: boolean
  hasHoldings: boolean
  staleDays: number | null
  lastUpdated: string
}

const loading = ref(true)
const accounts = ref<Account[]>([])
const positions = ref<Position[]>([])
/** 每个账户的输入草稿（总投入 / 现金，单位为元） */
const draft = ref<Record<number, { invested: string; cash: string; busy: boolean }>>({})

const investAccounts = computed(() => accounts.value.filter((a) => a.asset_type === 'investment'))

function positionOf(id: number): Position | null {
  return positions.value.find((p) => p.accountId === id) ?? null
}

async function load() {
  loading.value = true
  try {
    const [accRes, portRes] = await Promise.all([
      api.get('/accounts'),
      api.get('/assets/portfolio'),
    ])
    if (accRes.data.code === 0) accounts.value = accRes.data.data.items
    if (portRes.data.code === 0) positions.value = portRes.data.data.accounts

    const next: typeof draft.value = {}
    for (const a of investAccounts.value) {
      const p = positionOf(a.id)
      next[a.id] = {
        invested: a.invested_total != null ? String(a.invested_total / 100) : '',
        cash: p ? String(p.cash / 100) : '',
        busy: false,
      }
    }
    draft.value = next
  } catch { toast.error('读取投资数据失败') } finally { loading.value = false }
}
onMounted(load)

/**
 * 保存后必须刷新顶部仪表：本页 `meta.cluster = true`，仪表就在正上方常驻，
 * 而它在 cluster 页之间切换时不会重新 mount（外壳里 v-if 常驻），
 * 加上 store 有 30s 去抖 —— 不主动刷的话页面数字变了、上面的净资产还是旧的。
 * （/assets 那边一直是对的，两页不一致才是问题。）
 */
function refreshAll() {
  void load()
  cluster.loadPortfolio()
}

/** 总投入：账户属性，只在存/取钱时改 */
async function saveInvested(acc: Account) {
  const d = draft.value[acc.id]
  if (!d) return
  const yuan = Number(d.invested)
  if (d.invested !== '' && !Number.isFinite(yuan)) { toast.warning('总投入格式不对'); return }
  d.busy = true
  try {
    const { data } = await api.put(`/assets/accounts/${acc.id}`, {
      invested_total: d.invested === '' ? null : Math.round(yuan * 100),
    })
    if (data.code === 0) { toast.success('总投入已更新'); refreshAll() }
  } catch { toast.error('更新失败') } finally { d.busy = false }
}

/** 现金：写今天的快照，和资产页「各账户余额」是同一份数据 */
async function saveCash(acc: Account) {
  const d = draft.value[acc.id]
  if (!d || d.cash === '') return
  const yuan = Number(d.cash)
  if (!Number.isFinite(yuan)) { toast.warning('现金格式不对'); return }
  d.busy = true
  try {
    const { data } = await api.put('/assets/snapshots', {
      items: [{ account_id: acc.id, balance: Math.round(yuan * 100) }],
    })
    if (data.code === 0) { toast.success('现金已记录'); refreshAll() }
  } catch { toast.error('记录失败') } finally { d.busy = false }
}

const pct = (v: number | null) => (v == null ? '' : `（${(v * 100).toFixed(1)}%）`)
</script>

<template>
  <div>
    <PageHeader
      title="投资"
      :subtitle="investAccounts.length ? `${investAccounts.length} 个理财账户 · 盈亏按「总价值 − 总投入」算` : '持仓明细与盈亏'"
    />

    <div v-if="loading" class="stack">
      <Skeleton variant="block" height="5rem" />
      <Skeleton variant="block" height="9rem" />
    </div>

    <template v-else-if="investAccounts.length">
      <div class="stack">
        <section v-for="acc in investAccounts" :key="acc.id" class="sheet inv">
          <!-- 账户头：总价值大字 -->
          <header class="inv-head">
            <span class="inv-name">{{ acc.name }}</span>
            <span v-if="positionOf(acc.id)?.value != null" class="inv-value amt">
              <Money :value="positionOf(acc.id)!.value!" size="lg" tone="neutral" sign="none" />
            </span>
            <span v-else class="inv-value inv-muted">总价值待补</span>
          </header>

          <div class="inv-readings">
            <div class="inv-cell">
              <span class="inv-label">持仓市值</span>
              <Money
                v-if="positionOf(acc.id)?.holdingsValue != null"
                :value="positionOf(acc.id)!.holdingsValue!" size="md" tone="neutral" sign="none"
              />
              <span v-else class="inv-muted">—</span>
            </div>
            <div class="inv-cell">
              <span class="inv-label">现金</span>
              <!-- 没填过就是 0（用户口径），不再是「未知」 -->
              <Money :value="positionOf(acc.id)?.cash ?? 0" size="md" tone="neutral" sign="none" />
            </div>
            <div class="inv-cell">
              <span class="inv-label">总投入</span>
              <Money
                v-if="acc.invested_total != null"
                :value="acc.invested_total" size="md" tone="muted" sign="none"
              />
              <span v-else class="inv-muted">未填</span>
            </div>
            <div class="inv-cell">
              <span class="inv-label">浮动盈亏</span>
              <!-- 三种「算不出」分开说，都不显示 0 / 假负数 -->
              <span v-if="positionOf(acc.id)?.unrealized != null"
                    :class="positionOf(acc.id)!.unrealized! >= 0 ? 'amt-income' : 'amt-expense'"
                    class="inv-pnl amt">
                {{ positionOf(acc.id)!.unrealized! >= 0 ? '+' : '−' }}<Money
                  :value="Math.abs(positionOf(acc.id)!.unrealized!)" size="md"
                  :tone="positionOf(acc.id)!.unrealized! >= 0 ? 'income' : 'expense'" sign="none"
                /><span class="inv-rate">{{ pct(positionOf(acc.id)!.unrealizedRate) }}</span>
              </span>
              <span v-else-if="positionOf(acc.id)?.holdingsPending" class="inv-muted" title="钱在券商里但还没录进持仓，不是亏损">
                持仓未配置
              </span>
              <!-- 有持仓有总投入但行情没到 —— 这一态曾经落到兜底文案「填总投入后显示」，
                   而总投入明明已经填了。行情是系统抓的，该说清是「等取价」不是「等你填」。 -->
              <span v-else-if="positionOf(acc.id)?.hasHoldings" class="inv-muted" title="持仓的现价还没抓到，拿到后自动算">
                待取价
              </span>
              <span v-else class="inv-muted">填总投入后显示</span>
            </div>
          </div>

          <!-- 两个输入：总投入（低频）+ 现金（每日）。都不用跳页 -->
          <div class="inv-form">
            <label>
              <span>总投入（元）</span>
              <input
                v-model="draft[acc.id]!.invested" class="inv-input amt" type="number"
                inputmode="decimal" step="0.01" placeholder="一共投进去多少"
                @change="saveInvested(acc)"
              />
            </label>
            <label>
              <span>现金（元）</span>
              <input
                v-model="draft[acc.id]!.cash" class="inv-input amt" type="number"
                inputmode="decimal" step="0.01" placeholder="今天账户里剩多少活钱"
                @change="saveCash(acc)"
              />
            </label>
            <span class="inv-hint">总投入只在存/取钱时改；加减仓不改它</span>
          </div>

          <div class="inv-holdings">
            <HoldingsEditor :account-id="acc.id" :account-name="acc.name" @changed="refreshAll" />
          </div>
        </section>
      </div>
    </template>

    <EmptyState
      v-else
      icon="trendUp"
      title="还没有理财账户"
      description="把某个账户的「账户类型」改成理财投资，这里就能配持仓、看盈亏。"
    >
      <RouterLink to="/assets" class="btn btn-primary btn-sm">去账户设置</RouterLink>
    </EmptyState>
  </div>
</template>

<style scoped>
.inv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 0.875rem 0.5rem;
}
.inv-name { font-size: 0.875rem; font-weight: 600; color: var(--color-ink-1); }
.inv-value { font-size: 1.125rem; }
.inv-readings {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem 1rem;
  padding: 0.5rem 0.875rem 0.75rem;
}
@media (min-width: 640px) { .inv-readings { grid-template-columns: repeat(4, 1fr); } }
.inv-cell { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.inv-label { font-size: 0.625rem; color: var(--color-ink-3); }
.inv-pnl { font-size: 0.9375rem; font-weight: 600; display: inline-flex; align-items: baseline; gap: 0.125rem; }
.inv-rate { font-size: 0.6875rem; font-weight: 500; }
.inv-muted { font-size: 0.75rem; color: var(--color-ink-4); }
.inv-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  background: var(--color-paper-sunk);
  border-top: 1px solid var(--color-rule-faint);
}
.inv-form label { display: flex; flex-direction: column; gap: 0.25rem; }
.inv-form label > span { font-size: 0.625rem; color: var(--color-ink-3); }
.inv-input {
  height: 1.875rem;
  width: 8.5rem;
  padding: 0 0.5rem;
  text-align: right;
  font-size: 0.8125rem;
  color: var(--color-ink-1);
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}
.inv-input:focus {
  outline: none;
  border-color: var(--color-action);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-action) 14%, transparent);
}
.inv-hint { font-size: 0.625rem; color: var(--color-ink-4); }
.inv-holdings { padding: 0.75rem 0.875rem 0.875rem; }
</style>
