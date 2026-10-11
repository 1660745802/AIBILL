<script setup lang="ts">
/**
 * 某理财账户的持仓（配置低频：一个月动一次）
 *
 * 只记 **代码 + 股数**。现价由系统每 15 分钟抓（盘中），市值 = 股数 × 现价。
 * 单只**不算盈亏**——用户要求「投入不要针对单只持仓股，计算总投入就可以」，
 * 盈亏只有一个数在账户级（见 Investments.vue 顶部读数）。
 *
 * 这同时消掉一个真实出现过的矛盾：同屏「账户浮盈 +14,170」和
 * 「同一只持仓行 −13,830」正负号打架。根因就是单只也算了成本。
 *
 * 取不到价显示「—」而不是 0（0 会被读成这只持仓归零了）。
 * 「增 / 减」只改股数，不改总投入——买卖不改变"一共投进去多少"。
 */
import { ref, computed, onMounted } from 'vue'
import { useToast } from '@/composables/useToast'
import AppIcon from '@/components/ui/AppIcon.vue'
import Money from '@/components/ui/Money.vue'
import {
  listInvestments, createInvestment, updateInvestment, deleteInvestment,
  type InvestmentItem,
} from '@/api/investments'

const props = defineProps<{
  accountId: number
  accountName: string
}>()
const emit = defineEmits<{ changed: [] }>()

const toast = useToast()

/** 币种符号：不标的话「213.000」会被读成 ¥213 */
const CURRENCY_SIGN: Record<string, string> = { HKD: 'HK$', USD: 'US$' } as const

/** 代码格式提示：默认收起，避免每个账户重复一大段说明 */
const showCodeHint = ref(false)

const holdings = ref<InvestmentItem[]>([])
const loading = ref(true)
const saving = ref(false)

/** 新增草稿：只有代码和股数两个字段 */
const addCode = ref('')
const addQty = ref('')
/** 正在调仓的那条（点「增/减」时展开） */
const adjusting = ref<{ id: number; dir: 1 | -1; n: string } | null>(null)

const rows = computed(() => holdings.value.filter((h) => h.accountId === props.accountId))

const unpricedCount = computed(() => rows.value.filter((r) => r.marketValue == null).length)

async function load() {
  loading.value = true
  try {
    const { data } = await listInvestments()
    if (data.code === 0) holdings.value = data.data.items
  } catch { /* 读不到不致命，UI 显示空态 */ } finally { loading.value = false }
}
onMounted(load)

async function add() {
  // ⚠️ Vue 对 `<input type="number">` 会自动套 `.number` 修饰符 → v-model 拿到的是
  // number，直接 .trim() 会抛「is not a function」。一律 String() 后处理。
  const code = String(addCode.value).trim()
  const rawQty = String(addQty.value).trim()
  if (!code) { toast.warning('请填代码，例如 518880'); return }
  // 空值不能当 0 —— 那会建出一条 0 股持仓，而 0 股也算「挂了持仓」，
  // 会让该账户在没行情时连现金一起从净资产里消失
  if (rawQty === '') { toast.warning('请填股数'); return }
  const qty = Number(rawQty)
  if (!Number.isFinite(qty) || qty < 0) { toast.warning('股数要填一个不小于 0 的数字'); return }
  saving.value = true
  try {
    const { data } = await createInvestment({ account_id: props.accountId, code, quantity: qty })
    if (data.code === 0) {
      toast.success('已添加')
      addCode.value = ''
      addQty.value = ''
      await load()
      emit('changed')
    } else toast.error(data.message || '添加失败')
  } catch { /* 提示见 api 拦截器 */ } finally { saving.value = false }
}

/**
 * 行内改股数。
 *
 * 两条静默路径在这里被堵住：
 *  - 清空输入框 → `<input type=number>` 的 value 是 ''，`Number('') === 0`
 *    → 会静默把持仓改成 0 股（等于清仓）。空值必须当「没改」而不是 0。
 *  - 负数或非数字 → 原来直接 return，输入框留着被拒的值、与库里不一致。
 *    现在提示 + reload 把输入框拉回真实值。
 */
async function setQty(h: InvestmentItem, e: Event) {
  const el = e.target as HTMLInputElement
  const raw = el.value.trim()
  /**
   * 回滚 DOM 值要**手动**写，不能只靠 `await load()`。
   *
   * 原因：输入框是 `:value="h.quantity"`。清空后再 load，h.quantity 仍是 10000
   * （没变）→ Vue 的 patch 认为 value 无需更新 → DOM 里留着用户清空的 ""。
   * 用户看到空框、库里是 10000，正是「输入框与库不一致」那个 bug。
   */
  const rollback = () => { el.value = String(h.quantity) }

  if (raw === '') { rollback(); return }            // 空 = 取消输入，不是 0
  const q = Number(raw)
  if (!Number.isFinite(q) || q < 0) {
    toast.warning('股数要填一个不小于 0 的数字')
    rollback()
    return
  }
  if (q === h.quantity) return
  try {
    const { data } = await updateInvestment(h.id, { quantity: q })
    if (data.code === 0) { emit('changed') }
    else { toast.error(data.message || '改股数失败'); rollback() }
  } catch { rollback() }
}

/** 加仓 / 减仓 N 股 */
async function applyAdjust(h: InvestmentItem) {
  const a = adjusting.value
  if (!a || a.id !== h.id) return
  const n = Number(a.n)
  if (!Number.isFinite(n) || n <= 0) { toast.warning('请填股数'); return }
  const next = h.quantity + a.dir * n
  if (next < 0) { toast.warning('减仓不能超过持有股数'); return }
  adjusting.value = null
  const q = next
  try {
    const { data } = await updateInvestment(h.id, { quantity: q })
    if (data.code === 0) {
      await load()
      emit('changed')
      toast.success(a.dir > 0 ? `已加仓 ${n} 股` : `已减仓 ${n} 股`)
    } else toast.error(data.message || '调仓失败')
  } catch { /* 提示见 api 拦截器 */ }
}

async function remove(h: InvestmentItem) {
  try {
    const { data } = await deleteInvestment(h.id)
    if (data.code === 0) { toast.success('已移除'); await load(); emit('changed') }
  } catch { /* 提示见 api 拦截器 */ }
}
</script>

<template>
  <div class="hold">
    <div class="hold-head">
      <span class="ledger-label ledger-label-solid">持仓</span>
      <span class="hold-hint">
        盘中每 15 分钟自动更新
        <template v-if="unpricedCount > 0"> · {{ unpricedCount }} 个待取价</template>
      </span>
    </div>

    <ul v-if="rows.length" class="hold-list">
      <li v-for="h in rows" :key="h.id" class="hold-row">
        <div class="hold-id">
          <span class="hold-name">{{ h.name || h.code }}</span>
          <span class="hold-code">{{ h.code }}</span>
        </div>

        <label class="hold-qty">
          <input
            class="hold-input amt"
            type="number"
            inputmode="decimal"
            step="0.0001"
            :value="h.quantity"
            :aria-label="`${h.name || h.code} 的股数`"
            @change="setQty(h, $event)"
          />
          <span>股</span>
        </label>

        <div class="hold-val amt">
          <!-- 没取到价：显示「—」，不显示 0 -->
          <template v-if="h.marketValue != null">
            <div class="hold-price">
              <!-- 现价要带币种：港股是港元、美股是美元。
                   不标的话「213.000」会被读成 ¥213，实际是 HK$213。 -->
              现价 <span v-if="h.currency && h.currency !== 'CNY'" class="hold-ccy">{{ CURRENCY_SIGN[h.currency] || h.currency }}</span>{{ h.quote?.price?.toFixed(3) ?? '—' }}
              <span v-if="h.quote?.changeRate != null" :class="h.quote.changeRate >= 0 ? 'amt-income' : 'amt-expense'">
                {{ h.quote.changeRate >= 0 ? '+' : '' }}{{ h.quote.changeRate.toFixed(2) }}%
              </span>
              <!-- 报日期而不是「刚刚」：行情日期来自市场自己，不要伪造新鲜度。
                   也帮用户一眼看出这个价是不是老的。 -->
              <span v-if="h.quote?.quoteDate" class="hold-qdate">{{ h.quote.quoteDate.slice(5) }}</span>
            </div>
            <Money :value="h.marketValue" size="sm" tone="neutral" sign="none" />
            <!-- 折算来源写出来，别让人怀疑这个数对不对 -->
            <div v-if="h.currency && h.currency !== 'CNY' && h.fxRate" class="hold-fx">
              按 1{{ h.currency }} = ¥{{ h.fxRate.toFixed(4) }} 折算
            </div>
          </template>
          <!-- 取不到价/缺汇率时带上代码和原因 -->
          <!-- 只说事实，不再重复「点刷新行情」——那个动作页面顶部只有一个入口，
               三处都写就成了噪音。 -->
          <span v-else-if="h.quote && !h.fxRate" class="hold-noquote">
            待补汇率
            <span class="hold-nq-code">{{ h.currency }} → CNY</span>
          </span>
          <span v-else class="hold-noquote">
            未取到价
            <span class="hold-nq-code">{{ h.code }}</span>
            <span class="hold-nq-hint">可能是代码不对</span>
          </span>
        </div>

        <div class="hold-ops">
          <button class="act" @click="adjusting = adjusting?.id === h.id && adjusting.dir === 1 ? null : { id: h.id, dir: 1, n: '' }">增</button>
          <button class="act" @click="adjusting = adjusting?.id === h.id && adjusting.dir === -1 ? null : { id: h.id, dir: -1, n: '' }">减</button>
          <button class="act act-danger" :aria-label="`移除 ${h.name || h.code}`" @click="remove(h)">删</button>
        </div>

        <!-- 加减仓：只填股数，总投入不动 -->
        <div v-if="adjusting?.id === h.id" class="hold-adjust">
          <span>{{ adjusting.dir > 0 ? '加仓' : '减仓' }}</span>
          <input
            v-model="adjusting.n"
            class="hold-input amt"
            type="number"
            inputmode="decimal"
            :placeholder="`股数`"
            @keydown.enter="applyAdjust(h)"
          />
          <span>股</span>
          <button class="btn btn-primary btn-sm" @click="applyAdjust(h)">确定</button>
          <button class="btn btn-quiet btn-sm" @click="adjusting = null">取消</button>
        </div>
      </li>
    </ul>

    <p v-else-if="!loading" class="hold-empty">
      还没有持仓。填代码和股数就行，现价和市值系统算。
    </p>

    <!-- 入口永远在：由「这是理财账户」驱动，不由「有没有持仓数据」驱动 -->
    <div class="hold-add">
      <input
        v-model="addCode"
        class="hold-input hold-add-code"
        placeholder="代码，如 518880"
        aria-label="新持仓代码"
        @keydown.enter="add"
      />
      <input
        v-model="addQty"
        class="hold-input amt hold-add-qty"
        type="number"
        inputmode="decimal"
        step="0.0001"
        placeholder="股数"
        aria-label="新持仓股数"
        @keydown.enter="add"
      />
      <button class="btn btn-primary btn-sm" :disabled="saving" @click="add">
        <AppIcon name="plus" :size="13" :stroke="2.2" />添加持仓
      </button>
    </div>

    <!-- 代码格式是这件事里最容易卡住的一环：A股 6 位、港股 5 位（可省前导零
         写成 4 位）、美股字母、港股指数又是字母代码。写错一个字符就静默「未取到价」，
         用户完全看不出哪里错了。给个能照着填的例子。 -->
    <!--
      代码格式提示收起来。它**每个账户重复一遍**，占掉大半版面，
      而它只在第一次填代码时才有用。默认一行「代码怎么填？」，点开才展开。
    -->
    <button
      v-if="!showCodeHint"
      class="hold-hint-btn"
      type="button"
      @click="showCodeHint = true"
    >代码怎么填？</button>
    <p v-else class="hold-codehint">
      A股/ETF 6 位（<code>518880</code>）· 港股 5 位（<code>00700</code>，或省前导零
      <code>0700</code>）· 港股指数带字母（<code>hkHSI</code>）· 美股字母（<code>AAPL</code>）。
      填好后现价和市值自动更新。
      <button class="hold-hint-close" type="button" @click="showCodeHint = false">收起</button>
    </p>
  </div>
</template>

<style scoped>
/* 持仓铺满卡片宽：行的「市值」列右对齐到卡片边缘，和头部「总价值」
   落在同一条竖轴上——右边缘对齐能让整列数字形成一道线，比缩在左边好扫。 */
.hold-head {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
}
.hold-hint { font-size: 0.625rem; color: var(--color-ink-4); }
.hold-list { margin-top: 0.5rem; }
.hold-hint { margin-left: auto; }
.hold-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--color-rule-faint);
}
.hold-row:first-child { border-top: 0; }
.hold-id { min-width: 0; }
/* 左侧身份区：名称是主，代码是副。两行行距收紧到像一个整体，
   不然名字和代码看起来是两个无关的东西。 */
.hold-id { display: flex; flex-direction: column; line-height: 1.25; }
.hold-name {
  display: block;
  font-size: 0.8125rem;
  color: var(--color-ink-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hold-code {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  letter-spacing: 0.01em;
  color: var(--color-ink-4);
}
.hold-qty { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.625rem; color: var(--color-ink-3); }
.hold-input {
  height: 1.75rem;
  width: 5.5rem;
  padding: 0 0.4rem;
  text-align: right;
  font-size: 0.75rem;
  color: var(--color-ink-1);
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-xs);
}
.hold-input:focus {
  outline: none;
  border-color: var(--color-action);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-action) 14%, transparent);
}
.hold-val { text-align: right; min-width: 5.5rem; }
.hold-price { font-size: 0.625rem; color: var(--color-ink-3); }
.hold-qdate { margin-left: 0.25rem; color: var(--color-ink-4); }
.hold-ccy { color: var(--color-ink-2); font-weight: 500; }
.hold-fx {
  font-size: 0.5625rem;
  color: var(--color-ink-4);
  margin-top: 0.05rem;
}
.hold-noquote {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.05rem;
  font-size: 0.625rem;
  color: var(--color-ink-3);
  text-align: right;
}
.hold-nq-code {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--color-ink-2);
}
.hold-nq-hint { color: var(--color-ink-4); font-size: 0.5625rem; }
.hold-ops { display: inline-flex; gap: 0.125rem; }
.hold-adjust {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0 0.125rem;
  font-size: 0.6875rem;
  color: var(--color-ink-3);
}
/* 空态是引导不是内容：小一号、贴紧下面的添加入口，不占一大块 */
.hold-empty {
  margin: 0.375rem 0 0.5rem;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-ink-4);
}
.hold-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-rule-faint);
}
.hold-add-code { width: 9rem; text-align: left; }
.hold-codehint {
  margin-top: 0.375rem;
  font-size: 0.625rem;
  line-height: 1.65;
  color: var(--color-ink-4);
}
.hold-hint-btn {
  margin-top: 0.375rem;
  padding: 0;
  background: none;
  border: 0;
  color: var(--color-ink-4);
  font-size: 0.625rem;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.hold-hint-btn:hover { color: var(--color-ink-2); }
.hold-hint-close {
  margin-left: 0.375rem;
  padding: 0;
  background: none;
  border: 0;
  color: var(--color-ink-3);
  font-size: 0.625rem;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.hold-codehint code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0 0.2em;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-xs);
}
.hold-add-qty { width: 5.5rem; }
</style>
