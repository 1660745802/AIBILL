/**
 * 行情采集：抓取 → 落库 → 降级事实。
 *
 * ## 它收拢了什么
 *
 * 之前「取一次行情」这件事有**五个**调用点（新增持仓后自动取 / 手动刷新 /
 * 列表接口的汇率自愈 / 定时汇率 / 定时行情），每个都自己写一遍
 * 「拼代码 → fetch → 有结果才落库 → 出错就吞」。于是同一件事有四种失败语义：
 * 静默 / 回响应 / 记日志 / 什么都不做，汇率那条甚至**绕过了 ECB 兜底**
 * （自动取价是直接问腾讯要 `wh*CNY`，腾讯一挂就永远拿不到汇率）。
 *
 * 这里把**实现**收成两个函数，接口小到没有策略开关：
 *   `acquireAndStorePrices(db, codes)`   —— 抓行情 + 落库 + 降级事实
 *   `acquireAndStoreFxRates(db, ccys)`  —— 走主源/兜底链 + 落库（带真实来源）
 *
 * ## 接口里没有什么（故意的）
 *
 * 不传「要不要过时段门禁」「失败怎么报」「要不要吞错」这类轴。
 * 那些是**调用点的策略**，留在各自的 adapter 里：
 *   - 交易时段门禁与节假日推断 → `services/scheduler.ts`
 *   - 逐代码反馈与中文文案 → `routes/investments.ts` 的手动刷新
 *   - 阻塞返回 + 吞错 → 新增持仓后的自动取价
 * 多一个轴就多一种组合要测，而组合本身不是这里的复杂度。
 *
 * 失败一律**不抛**，而是回到结果对象里（`reachable` / `unknown` / `degraded`）：
 * 「失败了什么都不做」和「失败了告诉人」是两个完全不同的产品行为，
 * 那是调用方的选择，不该由这个 module 替它选。
 *
 * ## deferred（已知，本轮不改）：用户文案上「接口挂了」与「代码全不认」仍合并
 *
 * `reachable` 在**一条都解析不出来**时也是 `false`（上游确实活着、只是没这些代码），
 * 于是手动刷新对「一个代码都没认」的场景仍然回 `message: 行情接口连不上，稍后再试`。
 * `degraded` 里已经分得出 `upstream_unreachable` / `upstream_status` / `empty_response`，
 * 也写进了日志，只是 route 还没把它换算成用户可见的差异文案——
 * 那是**已发布端点的 message**，按约束本轮不改。
 */
import { fetchQuotes, QuoteFetchError, normalizeCode, type Quote } from './quotes.js'
import { fetchFxRates, type FxSource } from './fx.js'
import { storeQuotes, type Db } from './investments-repo.js'

/**
 * 降级事实。给人看的那部分措辞由调用方决定，这里只给机器可判定的事实。
 *
 * 前三种**直接来自 `QuoteFetchError.kind`**（同名），不是本文件自己起的名：
 * 抓取失败时把 typed kind 原样搬过来，避免两套分类词表打架。
 */
export type DegradationCode =
  /** 上游不可达：DNS/连接/超时（非 QuoteFetchError 的原始异常都归这里） */
  | 'upstream_unreachable'
  /** 上游回了但状态码不对（限流 429、5xx…） */
  | 'upstream_status'
  /** 上游回了，一条都解析不出来：代码全不认，或它改格式了 */
  | 'empty_response'
  /** 请求了但没拿到的代码/币种 */
  | 'unknown_codes'
  | 'fx_missing'

export interface Degradation {
  code: DegradationCode
  /** 原始错误信息，方便排查；不要直接透给用户 */
  detail?: string
  /** 受影响的代码/币种 */
  subjects?: string[]
}

export interface PriceAcquisition {
  /** 归一后真正发出去的代码 */
  requested: string[]
  /** 解析成功的行情（原始顺序） */
  quotes: Quote[]
  /** 代码 → 行情，键是上游返回的那个代码（大小写敏感，勿再 lowerCase） */
  byCode: Map<string, Quote>
  /** 请求了但上游没给的代码 */
  unknown: string[]
  /**
   * 上游这一次有没有给出可解析的行情。
   * false = 接口挂了 / 超时 / 非 2xx / 一条都解析不出来。
   * 注意：**「代码都不认」也落在 false 里** —— 上游确实活着，
   * 只是没这些代码。两者对用户的建议完全不同，所以 `unknown` 要单独看。
   */
  reachable: boolean
  degraded: Degradation[]
  /** 实际写进库的行数 */
  stored: number
}

/**
 * 取一批代码的行情并落库。
 *
 * 落库语义与历史一致：**抓取失败一行都不写**（写一条错价比不写更危险），
 * 且用 `INSERT OR IGNORE` + 行情自带时间戳去重，同一时刻抓多少次都落成一条。
 */
export async function acquireAndStorePrices(db: Db, codes: string[]): Promise<PriceAcquisition> {
  const requested = [...new Set(codes.map(normalizeCode).filter(Boolean))]
  const base: PriceAcquisition = {
    requested, quotes: [], byCode: new Map(), unknown: [],
    reachable: true, degraded: [], stored: 0,
  }
  if (requested.length === 0) return base

  let quotes: Quote[]
  try {
    quotes = await fetchQuotes(requested)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // 分类靠**类型**，不靠文案：`QuoteFetchError` 自带 kind，
    // 网络层的原始异常（TypeError / AbortError）不是它 ⇒ 不可达。
    // 以前这里在文案里找 `/返回空/`，那句话在 sibling 模块里，
    // 它一改分类就静默变味（而且两家文案各写各的）。
    const code: DegradationCode = err instanceof QuoteFetchError ? err.kind : 'upstream_unreachable'
    return {
      ...base,
      reachable: false,
      unknown: requested,
      degraded: [{ code, detail }, { code: 'unknown_codes', subjects: requested }],
    }
  }

  const byCode = new Map(quotes.map((q) => [q.code, q]))
  const unknown = requested.filter((c) => !byCode.has(c))
  const degraded: Degradation[] = unknown.length > 0
    ? [{ code: 'unknown_codes', subjects: unknown }]
    : []

  // 落库带上真实来源（目前股价只有腾讯，但别让默认值掩盖这件事）；
  // `stored` 取**真实写入行数**（UNIQUE 去重掉的不计入）
  const rows = quotes.map((q) => ({ ...q, source: 'tencent' }))
  const stored = storeQuotes(db, rows)

  return {
    requested, quotes, byCode, unknown, reachable: true, degraded, stored,
  }
}

export interface FxAcquisition {
  requested: string[]
  /** 币种 → 1 单位该币种等于多少人民币 */
  rates: Map<string, number>
  /** 币种 → 它自己的来源。落库和汇报都用它，不要看汇总 */
  provenance: Map<string, FxSource>
  /** 汇总来源；两个源都参与过时是 `'mixed'` */
  source: 'tencent' | 'ecb' | 'mixed' | 'none'
  missing: string[]
  degraded: Degradation[]
  /** 两个源各自的失败原因（原文），供日志排查 */
  errors: string[]
  stored: number
}

/** 落库用的腾讯格式代码：whHKDCNY（兜底源没有这个命名空间，但表里就这么存） */
function fxCode(currency: string): string {
  return normalizeCode(`wh${currency.toUpperCase()}CNY`)
}

/**
 * 取汇率并落库（主源 → 兜底源，整条链在 `lib/fx.ts` 里）。
 *
 * 汇率行与股价行同表，但**必须带各自的来源**：以前 `storeQuotes` 写死
 * `'tencent'`，于是 ECB 补的汇率在库里也标成腾讯，出事时无从查证。
 * 日期同理：腾讯用行情自带时间戳，ECB 用数据源自己的 `date`，**都不盖今天**
 * ——盖今天就是在非交易日造出「汇率很新鲜」的假象。
 */
export async function acquireAndStoreFxRates(db: Db, currencies: string[]): Promise<FxAcquisition> {
  const result = await fetchFxRates(currencies)
  const provenance = new Map(result.rows.map((r) => [r.currency, r.source]))
  const degraded: Degradation[] = result.missing.length > 0
    ? [{ code: 'fx_missing', subjects: result.missing }]
    : []

  // stored = 真正落进去的行数：同一 (code, date, at) 已存在时去重掉，不算写入
  let stored = 0
  if (result.rows.length > 0) {
    stored = storeQuotes(db, result.rows.map((r) => ({
      code: fxCode(r.currency),
      name: `${r.currency}人民币`,
      price: r.rate,
      prevClose: null,
      changeRate: null,        // 汇率涨跌幅对估值没用，不编
      quoteDate: r.quoteDate,
      quoteAt: r.quoteAt,
      source: r.source,        // ← 真实来源，不再硬编码 tencent
    })))
  }

  return {
    requested: result.requested,
    rates: result.rates,
    provenance,
    source: result.source,
    missing: result.missing,
    degraded,
    errors: result.errors,
    stored,
  }
}

/* ══════════════════════════════════════════════════════════
   后台补汇率：同步盖戳的 60s 冷却（无需 single-flight）
   ══════════════════════════════════════════════════════════ */

/** 冷却窗口：这段时间内同一个币种不再重试。
 *  汇率是日更数据，失败后一分钟内重试毫无意义，而列表接口是**每次进来都跑**
 *  ——没有这个闸门，上游一挂，用户每刷一次页面就放大一次请求。 */
export const FX_BACKFILL_COOLDOWN_MS = 60_000

const lastTriedAt = new Map<string, number>()

/** 仅供测试：清掉冷却状态（模块级状态会跨用例残留） */
export function resetFxBackfillState(): void {
  lastTriedAt.clear()
}

export interface FxBackfill {
  /** 这次真的去取了哪些币种 */
  attempted: string[]
  /** 因为「刚试过」被挡下的币种 */
  skipped: string[]
  /** 真的取了才有；被完全挡下时是 null */
  acquisition: FxAcquisition | null
}

/**
 * **后台补汇率专用**的入口：带冷却闸门的 `acquireAndStoreFxRates`。
 *
 * 给「列表接口发现缺汇率就在后台补一下」这类**用户没主动要求**的补齐用——
 * 它的失败没人等，所以必须自己管住请求量：同一个币种**刚试过**就跳过，
 * 失败也跳过（有界重试），否则上游一挂、用户每刷一次页面就放大一次请求。
 *
 * ## 为什么无需 single-flight
 *
 * 因为**先同步盖 60s cooldown 时间戳，再发请求**：窗口覆盖一次尝试的最坏超时
 * （主源 `QUOTES_TIMEOUT_MS` + 兜底源 `ECB_TIMEOUT_MS` = 16s ≪ 60s），
 * 所以第二个调用必然撞在冷却上、与第一次**不可能重叠**——
 * 不必再维护一份 inFlight。
 * 这条下界由测试守护：窗口一旦被调到 ≤ 最坏超时，用例就红（那时才真需要 inFlight）。
 *
 * 主动触发的路径（手动刷新、新增持仓、定时任务）**不要**用它：
 * 那里用户/调度明确要求「现在就去取」，闸门只会让结果变得不可预测。
 */
export async function backfillFxRates(db: Db, currencies: string[]): Promise<FxBackfill> {
  const now = Date.now()
  const wanted = [...new Set(currencies.map((c) => c.toUpperCase()))].filter((c) => c !== 'CNY')
  const attempted: string[] = []
  const skipped: string[] = []
  for (const c of wanted) {
    const last = lastTriedAt.get(c)
    if (last != null && now - last < FX_BACKFILL_COOLDOWN_MS) { skipped.push(c); continue }
    lastTriedAt.set(c, now)          // ⚠️ 盖戳在 await **之前**，否则并发调用会双双穿过去
    attempted.push(c)
  }
  if (attempted.length === 0) return { attempted, skipped, acquisition: null }
  return { attempted, skipped, acquisition: await acquireAndStoreFxRates(db, attempted) }
}
