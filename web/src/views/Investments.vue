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
import AppIcon from '@/components/ui/AppIcon.vue'

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

/**
 * 账户还没配（没持仓、没现金、没填总投入）——
 * 这时读数区是三个 ¥0.00 相加，纯噪音。改用一个空态，把注意力引到下一步。
 */
function isBare(acc: Account): boolean {
  const p = positionOf(acc.id)
  return !p?.hasHoldings && (p?.cash ?? 0) === 0 && acc.invested_total == null
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
    const listRes = await api.get('/investments')
    if (listRes.data.code === 0) quoteStatus.value = listRes.data.data.quote ?? null

    const next: typeof draft.value = {}
    for (const a of investAccounts.value) {
      const p = positionOf(a.id)
      next[a.id] = {
        invested: a.invested_total != null ? String(a.invested_total / 100) : '',
        // 0 时留空：预填一个 0 看起来像「用户填过」，而且和总投入的
        // placeholder 行为不一致
        cash: p && p.cash !== 0 ? String(p.cash / 100) : '',
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

/* ══════════════════════════════════════════════
   手动刷新行情 + 反馈
   ══════════════════════════════════════════════
   之前「未取到价」是个死胡同：定时抓取有交易时段门禁（周末/夜间静默跳过），
   页面既不说为什么，也不给任何入口。用户只能干等。
   现在给个按钮，而且**如实说为什么**：没抓过 / 代码不对 / 网络不通。*/
/**
 * 时间戳 → 「10-09 16:08」。
 *
 * 要兼容**三种历史格式**——`quoted_at` 是按市场存的，老数据里同时存在：
 *   A股   20261009161450
 *   港股  2026/10/09 16:08:08
 *   新数据 2026-10-09 16:08:08（服务端已归一）
 */
function fmtQuoteTime(at: string): string {
  if (!at) return ''
  let m = at.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  m = at.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})/)
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  m = at.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  m = at.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)
  if (m) return `${m[2]}-${m[3]}`
  return at
}

/** 账户类型的中文标签（投资页账户头上用） */
const ASSET_LABEL: Record<string, string> = {
  investment: '理财投资', liquid: '活期', savings: '定期',
  credit: '信用卡', loan: '贷款', property: '不动产', other: '其他',
}

/** 哪个账户的「总投入 / 现金」编辑区展开着（默认都收起） */
const editing = ref<number | null>(null)

const refreshing = ref(false)
const quoteNote = ref<string | null>(null)      // 刚才这一次的结果（临时反馈）
/**
 * 行情状态**来自服务端数据**，不是前端自己记的。
 *
 * 之前是一个只在手动刷新时赋值的 ref，于是页面一加载就显示「行情未获取过」——
 * 哪怕库里早有数据。用户根本看不到「上一次刷新时间」。
 */
const quoteStatus = ref<{
  lastAt: string | null
  lastDate: string | null
  pricedCount: number
  totalCount: number
  schedule?: { fetch: boolean; reason: string }
} | null>(null)

async function refreshQuotes() {
  refreshing.value = true
  quoteNote.value = null
  try {
    const { data } = await api.post('/investments/quotes/refresh')
    if (data.code !== 0) { toast.error(data.message || '刷新失败'); return }
    const d = data.data
    quoteNote.value = d.missing?.length
      ? `${d.fetched} 个已更新，${d.missing.length} 个取不到价`
      : `已更新 ${d.fetched} 个标的`
    // 刷新完重新拉一次列表：状态和时间都从数据里来
    await load()

    if (d.total === 0) { toast.info('没有活跃持仓，无需刷新行情'); return }

    if (d.network === false) {
      quoteNote.value = '行情接口连不上，稍后再试'
      toast.error(quoteNote.value)
      return
    }

    quoteNote.value = d.missing?.length
      ? `${d.fetched} 个已更新，${d.missing.length} 个取不到价`
      : `已更新 ${d.fetched} 个标的`

    if (d.missing?.length) {
      // 拿不到的不静默：逐个说清原因
      const codes = d.missing.map((m: any) => m.code).join('、')
      toast.warning(`${codes} 取不到价，检查代码是否填对`)
    } else {
      toast.success(quoteNote.value)
    }
    cluster.loadPortfolio()
  } catch {
    toast.error('刷新失败')
  } finally { refreshing.value = false }
}
</script>

<template>
  <div>
    <PageHeader
      title="投资"
      :subtitle="investAccounts.length ? `${investAccounts.length} 个理财账户 · 盈亏按「总价值 − 总投入」算` : '持仓明细与盈亏'"
    />

    <!-- 行情状态条：把「为什么没更新」摊在脸上，而不是让用户自己猜。
         这块是整个页面最需要的反馈——之前它一片空白，用户不知道是自己配错
         还是系统没跑。 -->
    <div class="quote-bar">
      <div class="quote-bar-info">
        <!--
          时间来自服务端数据（库里最新一条行情），不是前端记的——
          这样打开页面就能看到「上次更新 X」，不必先点一次刷新。
        -->
        <span v-if="quoteStatus?.lastAt" class="quote-at">
          行情更新于 {{ fmtQuoteTime(quoteStatus.lastAt) }}
          <span v-if="quoteStatus.pricedCount < quoteStatus.totalCount" class="quote-partial">
            （{{ quoteStatus.pricedCount }}/{{ quoteStatus.totalCount }} 个标的）
          </span>
        </span>
        <span v-else-if="quoteStatus && quoteStatus.totalCount > 0" class="quote-at quote-at-quiet">
          还没有取到过行情
        </span>
        <span v-if="quoteStatus?.schedule && !quoteStatus.schedule.fetch" class="quote-gate">
          自动更新暂停：{{ quoteStatus.schedule.reason }}
        </span>
        <span v-if="quoteNote" class="quote-note">{{ quoteNote }}</span>
      </div>
      <button
        class="btn btn-quiet btn-sm"
        :disabled="refreshing"
        aria-label="刷新行情"
        @click="refreshQuotes"
      >
        <AppIcon name="refresh" :size="13" :stroke="2.2" :class="refreshing ? 'spin' : ''" />
        {{ refreshing ? '刷新中…' : '刷新行情' }}
      </button>
    </div>

    <div v-if="loading" class="stack">
      <Skeleton variant="block" height="5rem" />
      <Skeleton variant="block" height="9rem" />
    </div>

    <template v-else-if="investAccounts.length">
      <div class="stack">
        <section v-for="acc in investAccounts" :key="acc.id" class="sheet inv">
          <!--
            账户头：账户名在左，**总价值**大字在右——这是这个账户唯一的主读数。
            算不出总价值时不给「总价值待补」这种空话（下面分项已经说明了原因），
            改成一句指向下一步的短提示。
          -->
          <header class="inv-head">
            <div class="inv-head-main">
              <span class="inv-name">{{ acc.name }}</span>
              <span class="inv-tag">{{ ASSET_LABEL[acc.asset_type] || '理财投资' }}</span>
            </div>
            <!-- 读数的统一排版：标签在上、数字在下。
                 之前标签在数字**下面**，和下面 .inv-cell 的 label/value 顺序不一致，
                 同一屏里两种排版规则，眼睛要来回切换。 -->
            <!--
              主读数必须始终有一个数字。之前 value 为空时整个 header 是空的，
              页面于是没有任何主导数字，全是小标签——「主体不突出」就是这么来的。
              总价值 = 持仓市值 + 现金；持仓还没取到价时现金是已知的下限，
              所以显示「≥ 现金」，而不是给一片空白。
            -->
            <!-- 空账户不摆一个 ¥0.00：那既不是读数也不是信息，只是噪音。
                 有内容之后才出现主读数。 -->
            <span class="inv-value" v-if="!isBare(acc)">
              <span class="inv-value-cap">{{ positionOf(acc.id)?.value != null ? '总价值' : '总资产下限' }}</span>
              <span class="amt" v-if="positionOf(acc.id)?.value != null">
                <Money :value="positionOf(acc.id)!.value!" size="lg" tone="neutral" sign="none" />
              </span>
              <span class="amt inv-value-min" v-else>
                <span class="inv-ge">≥</span><Money :value="positionOf(acc.id)?.cash ?? 0" size="lg" tone="neutral" sign="none" />
              </span>
            </span>
          </header>

          <!-- 空账户：不摆三个 ¥0.00，直接说下一步做什么。
               一句就够，不再单独占一行加一个大空块。 -->
          <div v-if="isBare(acc)" class="inv-bare">
            还没有内容 —— 在下面配持仓，或填一下总投入 / 现金。
          </div>

          <!--
            读数铺满整行（桌面 4 列 / 手机 2 列）。
            之前是「两个一组、左对齐」，卡片宽的时候右半边整片空着；
            四个读数其实是同一层级的信息，摊开反而更好扫。
          -->
          <div v-else class="inv-readings">
            <div class="inv-cell">
              <span class="inv-label">持仓市值</span>
              <Money
                v-if="positionOf(acc.id)?.holdingsValue != null"
                :value="positionOf(acc.id)!.holdingsValue!" size="md" tone="neutral" sign="none"
              />
              <span v-else class="inv-muted">待取价</span>
            </div>
            <div class="inv-cell">
              <span class="inv-label">现金</span>
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
              <span v-if="positionOf(acc.id)?.unrealized != null"
                    :class="positionOf(acc.id)!.unrealized! >= 0 ? 'amt-income' : 'amt-expense'"
                    class="inv-pnl amt">
                {{ positionOf(acc.id)!.unrealized! >= 0 ? '+' : '−' }}<Money
                  :value="Math.abs(positionOf(acc.id)!.unrealized!)" size="md"
                  :tone="positionOf(acc.id)!.unrealized! >= 0 ? 'income' : 'expense'" sign="none"
                /><span class="inv-rate">{{ pct(positionOf(acc.id)!.unrealizedRate) }}</span>
              </span>
              <!-- 算不出的三种情况各说各的原因，不显示 0、不假造负数 -->
              <span v-else-if="positionOf(acc.id)?.holdingsPending" class="inv-muted">持仓未配置</span>
              <span v-else-if="positionOf(acc.id)?.hasHoldings" class="inv-muted">待取价</span>
              <span v-else class="inv-muted">填总投入后显示</span>
            </div>
          </div>

          <!--
            总投入 / 现金的编辑**默认收起**。
            这两个是低频动作（总投入只在存/取钱时改，现金想起来才记），
            常驻两个输入框+一行说明，占掉一整行而 99% 的时间你不看它。
            需要时点开，改完自动收起。
          -->
          <div class="inv-edit">
            <button
              class="inv-edit-toggle"
              type="button"
              :aria-expanded="editing === acc.id"
              @click="editing = editing === acc.id ? null : acc.id"
            >
              <AppIcon :name="editing === acc.id ? 'chevronUp' : 'chevronDown'" :size="12" />
              {{ editing === acc.id ? '收起' : '改总投入 / 现金' }}
            </button>

            <div v-if="editing === acc.id" class="inv-form">
              <div class="inv-form-grid">
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
                    inputmode="decimal" step="0.01" placeholder="今天还剩多少活钱"
                    @change="saveCash(acc)"
                  />
                </label>
              </div>
              <p class="inv-hint">总投入只在存/取钱时改；加减仓不改它。现金随手改，改完即生效。</p>
            </div>
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
/* 行情状态条：把「为什么没更新」摊在脸上。之前这块一片空白，
   用户不知道是自己配错还是系统没跑——这是反馈差的根子。 */
.quote-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.875rem;
  margin-bottom: 0.75rem;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule-faint);
  border-radius: var(--radius-sm);
}
.quote-bar-info {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.375rem 0.75rem;
  min-width: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
}
.quote-at { color: var(--color-ink-3); }
.quote-at-quiet { color: var(--color-ink-4); }
.quote-gate { color: var(--color-warn, var(--color-ink-3)); }
.quote-note { color: var(--color-ink-2); font-weight: 500; }
.quote-partial { color: var(--color-ink-4); }
.inv-act-hint {
  color: var(--color-action);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  margin-left: 0.25rem;
}
.inv-act-hint:hover { opacity: 0.75; }
.spin {
  animation: quote-spin 0.9s linear infinite;
}
@keyframes quote-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
.inv-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.875rem 0.875rem 0.625rem;
}
.inv-head-main { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.inv-name { font-size: 0.9375rem; font-weight: 600; color: var(--color-ink-1); }
.inv-tag {
  font-size: 0.625rem;
  color: var(--color-ink-4);
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}
/* 主读数：标签在上、数字在下，右对齐。
   数字比下面的 cell 大两档，形成「一个主读数 + 若干辅读数」的层次。 */
/* 主读数：比下面的辅读数大两档。页面上必须有一个「最大的数字」，
   否则整屏都是等大的小字，读者不知道该先看哪。 */
.inv-value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.05;
}
.inv-value .money { font-size: 1.375rem; font-weight: 600; letter-spacing: -0.01em; }
.inv-ge { color: var(--color-ink-3); margin-right: 0.125rem; font-weight: 500; }
.inv-value-min .money { color: var(--color-ink-2); }
.inv-value-cap {
  font-size: 0.5625rem;
  line-height: 1;
  color: var(--color-ink-4);
  letter-spacing: 0.02em;
  margin-bottom: 0.25rem;
}

/* 读数分成两组：先看总价值怎么来的，再看投了多少赚了多少。
   四格平铺看不出加数和结果，读者得自己在脑子里做加法。 */
/* 读数铺满：手机 2 列、桌面 4 列。四个读数同级，摊开比「两两一组左对齐」好扫。 */
.inv-readings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  padding: 0.125rem 0.875rem 0.75rem;
}
@media (min-width: 768px) {
  .inv-readings { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.inv-edit { padding: 0 0.875rem 0.5rem; }
.inv-edit-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0;
  background: none;
  border: 0;
  color: var(--color-ink-4);
  font-size: 0.625rem;
  cursor: pointer;
}
.inv-edit-toggle:hover { color: var(--color-ink-2); }
/* 空账户：一句引导，而不是三个 0.00 相加 */
.inv-bare {
  padding: 0 0.875rem 0.625rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--color-ink-4);
}
.inv-op { font-size: 0.75rem; color: var(--color-ink-4); padding-bottom: 0.125rem; }
/* cell 内部排版：标签固定高度（避免有的标签换行把数字顶歪）、
   数字走同一条基线。同一行几个 cell 才对得齐。 */
.inv-cell { display: flex; flex-direction: column; min-width: 0; }

.inv-label {
  font-size: 0.5625rem;
  line-height: 1;
  color: var(--color-ink-4);
  letter-spacing: 0.02em;
  margin-bottom: 0.25rem;
  white-space: nowrap;
}
/* 辅读数字号统一小一档，和主读数拉开层级 */
.inv-cell .money { font-size: 0.8125rem; }
.inv-pnl { font-size: 0.9375rem; font-weight: 600; display: inline-flex; align-items: baseline; gap: 0.125rem; }
.inv-rate { font-size: 0.6875rem; font-weight: 500; }
.inv-muted { font-size: 0.75rem; color: var(--color-ink-4); }
.inv-form {
  margin-top: 0.5rem;
  padding: 0.625rem 0.75rem 0.75rem;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule-faint);
  border-radius: var(--radius-sm);
}
/* 限宽：宽屏下两个输入框被拉到卡片两端、中间空一大片，读起来像两个孤立的框。
   限宽后它们自然靠在一起。 */
.inv-form-grid {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  max-width: 30rem;
}
/* 输入块的 label 排版和读数 label 保持同一套（大小/颜色/间距），
   「看」和「改」两块节奏一致，不会感觉是两套设计。 */
.inv-form label {
  display: flex;
  flex-direction: column;
  flex: 0 1 14rem;
  min-width: 8rem;
}
.inv-form label > span {
  font-size: 0.5625rem;
  line-height: 1;
  color: var(--color-ink-4);
  letter-spacing: 0.02em;
  margin-bottom: 0.25rem;
}
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
