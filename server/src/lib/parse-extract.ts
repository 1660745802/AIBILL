/**
 * 解析出参的机械抽取（契约 docs/API.md 附录 C §6）
 *
 * 原则：**全部机械推导/抽取，绝不进 prompt**——模型只输出
 * `type/amount/category/description/date/account/target_account`。
 * 再加 7 个键会让模型每次多输出约 7×N 个键，且 identifier（订单号/卡尾号）
 * 属纯复制、幻觉高发，所以一律由正文正则机械抽取。
 *
 * 本模块**不碰 DB/HTTP**，只做纯字符串判定，便于单测与两端审计。
 * 每个函数都遵循「宁可给 null，也不猜错」：命中不了一个明确、可判定的形态
 * 就返回 null，绝不拿整句/整段当结果。
 */
import { hasCorroboration } from '../ai/verify.js'

/* ══════════════════════════════════════════════════════════
   一、商户名
   ══════════════════════════════════════════════════════════ */

/** 常见商户分隔符：全/半角连字符、破折号、管道、间隔号 */
const MERCHANT_SEPARATORS = /[-–—|丨·•]/

/**
 * 不是「商户」的来源/账户词。
 * 云控 source_mapping 的友好名优先，但支付渠道/账户类词不能当商户——
 * 否则所有微信通知的商户都会变成「微信支付」，污染分类预填与学习。
 * 命中它们时回落正文抽取；抽取不到宁可 null。
 */
const NON_MERCHANT_SOURCE = new Set([
  '支付宝', '微信', '微信支付', '云闪付', '银联', '京东支付', '财付通',
  '银行卡', '信用卡', '储蓄卡', '借记卡', '花呗', '余额', '零钱', '现金',
])

/** 通知标题 / 交易状态 / 金额语境词，单独成片段时不能当商户 */
const MERCHANT_NOISE_EXACT =
  /^(消费|支付|付款|转账|收款|退款|充值|提现|到账|入账|扣款|扣费|交易|订单|尾号|卡号|卡尾|流水|结余|应收|应付|收入|支出|缴费|还款|报销|退货|余额|剩余|可用|账户|动账|成功|完成)$/

/** 片段里出现这些词说明它是状态/标题，不是商户名 */
const MERCHANT_NOISE_SUB = /记账日报|动账通知|交易提醒|消费提醒|收支通知|支付成功|付款成功|交易成功|支付完成|到账通知/

/**
 * 一个片段「像不像」商户名。保守：只要有任何可疑迹象就判否。
 * - 长度 2..20（单字/长句都不是商户）
 * - 不含数字（卡号/日期/金额片段一律排除）
 * - 不是来源/账户词、不是状态噪声词、不是纯 ASCII 字母（多半是状态码）
 */
function isPlausibleMerchant(s: string): boolean {
  const v = s.trim()
  if (v.length < 2 || v.length > 20) return false
  if (NON_MERCHANT_SOURCE.has(v)) return false
  if (MERCHANT_NOISE_EXACT.test(v)) return false
  if (MERCHANT_NOISE_SUB.test(v)) return false
  if (/\d/.test(v)) return false
  if (/^[A-Za-z]+$/.test(v)) return false
  return true
}

/**
 * 抽取商户名（供分类预填与学习）。
 *
 * 为什么保守：
 * - 通知里没有稳定字段标出「商户」，唯一可靠的机械信号是**显式分隔**：
 *   括号 `【美团】` 或分隔符 `支付宝-美团外卖`。没有它们就返回 null，
 *   **绝不**把整句（含金额/状态）当商户。
 * - 含数字的片段一律不认——避免把卡尾号/日期/金额片段当成商户。
 * - 云控 `source_mapping` 的友好名优先（如美团 App → 美团），但支付渠道
 *   词（微信支付/支付宝）会被过滤掉，否则所有微信通知的商户都错成渠道名。
 *
 * @param text 解析正文（通常是请求的 `input`）
 * @param sourceName 云控 `source_mapping` 解析出的友好名（可选）
 */
export function extractMerchant(text: string, sourceName?: string): string | null {
  const src = (sourceName ?? '').trim()
  if (src && isPlausibleMerchant(src)) return src

  const t = text ?? ''

  // 1) 括号形态：【美团】→ 美团
  const bracket = t.match(/【([^】]{1,30})】/)
  if (bracket) {
    const c = bracket[1]!.trim()
    if (isPlausibleMerchant(c)) return c
  }

  // 2) 分隔符形态：支付宝-美团外卖 → 美团外卖。
  // 逐段扫描，每段跳过开头的状态词后取第一个像商户的 token；两侧合计
  // 只允许**唯一**候选，多个候选=歧义 → null（不猜）。
  const parts = t.split(MERCHANT_SEPARATORS)
  if (parts.length >= 2) {
    const cands: string[] = []
    for (const part of parts) {
      for (const tok of part.split(/\s+/).filter(Boolean)) {
        if (MERCHANT_NOISE_EXACT.test(tok)) continue // 跳过「支付成功」这类前缀
        if (isPlausibleMerchant(tok)) cands.push(tok)
        break
      }
    }
    if (cands.length === 1) return cands[0]!
  }

  return null
}

/* ══════════════════════════════════════════════════════════
   二、订单号 / 卡尾号
   ══════════════════════════════════════════════════════════ */

/**
 * 抽取订单号/交易单号/流水号。
 *
 * 为什么保守：
 * - 只认「关键词 + 紧随其后的字母数字串」，长度 6..32，且**必须含数字**
 *   （否则「交易号待确认」这种英文状态词会被误抽）。
 * - 上限 32：超长串不截断，直接返回 null——半截单号比没有更坏（会被当真值复制）。
 * - 必须整串结束（`(?!\w)`），避免从一个更长数字里切一半出来。
 */
export function extractOrderNo(text: string): string | null {
  const t = text ?? ''
  const m = t.match(/(?:订单号|交易单号|流水号|交易号)\s*[:：]?\s*([A-Za-z0-9]{6,32})(?!\w)/)
  if (!m) return null
  const v = m[1]!
  if (!/\d/.test(v)) return null // 必须含数字，排除纯字母状态词
  return v
}

/**
 * 抽取卡尾号（「尾号1234」「末四位1234」）。
 *
 * 为什么保守：
 * - 只认 4 位数字且右侧不再跟数字（`(?!\d)`），`尾号12345` 直接判否，
 *   绝不截前 4 位——错一位就是另一张卡。
 * - 「消费」等金额语境不经手，卡尾号与金额是两回事。
 */
export function extractCardTail(text: string): string | null {
  const t = text ?? ''
  const m = t.match(/(?:尾号|末四位|尾数|卡号后四位)\s*[:：]?\s*(\d{4})(?!\d)/)
  return m ? m[1]! : null
}

/* ══════════════════════════════════════════════════════════
   三、余额（词界受限）
   ══════════════════════════════════════════════════════════ */

/**
 * 余额数字后跟随的「量词」——说明这是数量不是金额。
 * 例如「剩余100张」「余额100积分」。
 */
const MEASURE_AFTER =
  /^(笔|个|张|条|天|次|件|人|份|年|月|日|号|位|只|台|瓶|包|箱|本|部|辆|枚|款|种|项|股|手|杯|碗|盒|袋|积分|分|点|层|级|度|米|公里|克|公斤|斤)/

/**
 * 余额上下文 + 金额。数字允许千分位，返回的是**原始片段**（含前缀词），
 * 供客户端按前缀做同模板自比（契约 §6）。
 */
const BALANCE_RE = new RegExp(
  '(可用余额|账户余额|余额|剩余)\\s*(?:为|是)?\\s*[:：]?\\s*([¥￥])?\\s*'
  + '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)(?![\\d,.])'
  + '(\\s*(元|圆|块钱|块|人民币|RMB|CNY))?',
  'gi',
)

export interface BalanceHit {
  /** 金额（分）；仅作提示，语义未定（可用余额 vs 账户余额无法区分） */
  cents: number
  /** 命中的**原始片段**，含「可用余额」等前缀词 */
  text: string
}

/**
 * 抽取余额（「余额/剩余/可用余额/账户余额」后的金额）。
 *
 * 为什么必须**词界受限**：
 * - 没有上下文词的金额一律不抽——`转账1000` 里的 1000 是交易额，不是余额。
 * - 即便有上下文词，也要像「金额」：带 ¥、带单位、或带小数点；否则必须是
 *   ≥3 位的整数且后面不跟量词（排除「剩余100张」这类数量）。
 * - 返回原始片段而非归一化文本，客户端才能判断两次通知是不是同一模板。
 */
export function extractBalance(text: string): BalanceHit | null {
  const t = text ?? ''
  BALANCE_RE.lastIndex = 0
  for (const m of t.matchAll(BALANCE_RE)) {
    const symbol = m[2]
    const numStr = m[3]!
    const unit = m[5]
    const n = Number(numStr.replace(/,/g, ''))
    if (!Number.isFinite(n)) continue

    const after = t.slice((m.index ?? 0) + m[0].length)
    const monetary = !!symbol || !!unit || numStr.includes('.')
    if (!monetary) {
      const intDigits = numStr.replace(/,/g, '').length
      if (intDigits < 3) continue
      if (MEASURE_AFTER.test(after)) continue
      if (/^[A-Za-z]/.test(after)) continue // 剩余100GB / 12MB
    }

    return { cents: Math.round(n * 100), text: m[0].trim() }
  }
  return null
}

/* ══════════════════════════════════════════════════════════
   四、时刻
   ══════════════════════════════════════════════════════════ */

/** 24 小时制 `HH:mm` / `H:mm`（全/半角冒号） */
const COLON_TIME = /(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d)/
/** `H点mm分` / `H时mm` */
const DOT_TIME = /(?<!\d)([01]?\d|2[0-3])\s*[点時时]\s*([0-5]?\d)\s*分?/
/** `H点`（无分钟）——只有带「上午/下午」前缀才可靠 */
const DOT_HOUR_ONLY = /(?<!\d)([01]?\d|2[0-3])\s*[点時时](?!\d)/
const MERIDIEM_AT_END = /(上午|下午|中午|凌晨|清晨|早上|晚上|傍晚|夜里|深夜)\s*$/

/** 取匹配位置**紧邻前面**的上午/下午等前缀 */
function meridiemBefore(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 4), index)
  const m = before.match(MERIDIEM_AT_END)
  return m ? m[1]! : null
}

/** 把 12 小时口语时间归一到 24 小时制 */
function adjustMeridiem(hour: number, meridiem: string | null): number {
  if (!meridiem) return hour
  if (/上午|凌晨|清晨|早上/.test(meridiem)) return hour >= 12 ? hour % 12 : hour
  if (/中午/.test(meridiem)) return hour
  return hour < 12 ? hour + 12 : hour
}

function fmtTime(hour: number, minute: number): string | null {
  if (minute < 0 || minute > 59) return null
  const h = ((hour % 24) + 24) % 24
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 抽取正文里的明确时刻 → `HH:mm`（与 `POST /transactions` 同格式）。
 *
 * 为什么保守：
 * - 只认带冒号或「点/时」的时刻形态，**绝不**从日期（`2026-10-12`）或
 *   金额（`50.00`）里的数字猜时间——那会把日期当时刻。
 * - 「3点」这种无分钟且无上午/下午前缀的写法有歧义（凌晨还是下午？），返回 null。
 * - 带上午/下午前缀时按 12 小时制归一，避免「下午3点」被写成 03:00。
 */
export function extractTime(text: string): string | null {
  const t = text ?? ''

  const colon = COLON_TIME.exec(t)
  if (colon) {
    const h = adjustMeridiem(Number(colon[1]), meridiemBefore(t, colon.index))
    return fmtTime(h, Number(colon[2]))
  }

  const dot = DOT_TIME.exec(t)
  if (dot) {
    const h = adjustMeridiem(Number(dot[1]), meridiemBefore(t, dot.index))
    return fmtTime(h, Number(dot[2]))
  }

  const dotHour = DOT_HOUR_ONLY.exec(t)
  if (dotHour) {
    const m = meridiemBefore(t, dotHour.index)
    if (!m) return null // 「3点」不可靠
    return fmtTime(adjustMeridiem(Number(dotHour[1]), m), 0)
  }

  return null
}

/* ══════════════════════════════════════════════════════════
   五、一次抽齐（供 items 挂字段）
   ══════════════════════════════════════════════════════════ */

export interface ParsedExtras {
  merchant: string | null
  order_no: string | null
  card_tail: string | null
  balance_after_cents: number | null
  balance_text: string | null
  time: string | null
}

/**
 * 对一条解析请求抽齐 §6 的六个机械字段。
 *
 * 搜索空间：`input` 为主；`input` 抽不到时可退回 `title`/`body`（S2 已收）。
 * 一个函数一个函数地各自回落（`fn(input) ?? fn(fallback)`）。
 *
 * ⚠️ 注意：**只有抽取**可以退回 title/body；`deriveReviewMeta` 的 tier/佐证
 * 判据**只许用 input`**（S2 已明确 title/body 暂不参与判据）。所以调用方务必
 * 给 `deriveReviewMeta` 传 `input`，而不是这里的 fallback 文本。
 */
export function extractParsedExtras(
  input: string,
  opts: { fallbackText?: string; sourceName?: string } = {},
): ParsedExtras {
  const primary = input ?? ''
  const fallback = opts.fallbackText ?? ''
  const pick = <T>(fn: (s: string) => T | null): T | null =>
    fn(primary) ?? (fallback ? fn(fallback) : null)

  const merchant =
    extractMerchant(primary, opts.sourceName)
    ?? (fallback ? extractMerchant(fallback, opts.sourceName) : null)
  const balance = pick(extractBalance)

  return {
    merchant,
    order_no: pick(extractOrderNo),
    card_tail: pick(extractCardTail),
    // balance_text 与 balance_after_cents 必定同来同往（同一元素内）
    balance_after_cents: balance ? balance.cents : null,
    balance_text: balance ? balance.text : null,
    time: pick(extractTime),
  }
}

/* ══════════════════════════════════════════════════════════
   六、needs_review / confidence（契约 §6 的**唯一实现**）
   ══════════════════════════════════════════════════════════ */

export type Confidence = 'high' | 'medium' | 'low'

export interface ReviewMetaInput {
  /** 入口路径：quick（本地正则）或 ai（模型） */
  path: 'quick' | 'ai'
  /** 分类是否**精确命中**（模糊匹配/回落「其他」为 false；转账视为 true） */
  categoryExact: boolean
  /** 金额（分） */
  amountCents: number
  /** 仅 `input`：tier/佐证判据只许用 input */
  input: string
  /** classifyNotification 的 reasons（AI 路径有；quick 路径为空） */
  classifyReasons?: string[]
  /** verifyParsed 对**这一项**的判定（AI 路径有） */
  verifyVerdict?: 'pass' | 'drop' | 'review'
}

export interface ReviewMeta {
  confidence: Confidence
  confidence_reasons: string[]
  needs_review: boolean
}

/**
 * 派生 `needs_review` / `confidence` / `confidence_reasons`。
 *
 * `needs_review`（客户端「不自动入账」的**唯一**判据）为 true 当任一成立：
 *   1. `verifyParsed` 对该项判 `review`（AI 路径，金额无佐证）；
 *   2. 分类**未精确命中**（模糊匹配或回落到「其他」）；
 *   3. 金额来自**裸数字**信号（`classification.reasons` 含 `bare_amount`）。
 *
 * `confidence`：
 *   - `high`   = quick 路径 + 分类精确命中 + 金额带单位；
 *   - `medium` = ai 路径 + 分类精确命中 + 佐证通过；
 *   - 其余（含 needs_review）一律 `low`。
 *
 * `confidence_reasons` 用稳定短名，便于两端审计同一套阈值。
 */
export function deriveReviewMeta(o: ReviewMetaInput): ReviewMeta {
  const hasUnit = hasCorroboration(o.input, o.amountCents)
  const bareAmount = (o.classifyReasons ?? []).includes('bare_amount')
  const verifyReview = o.verifyVerdict === 'review'

  // needs_review 的四个来源里，quick 路径没有 verify/bare_amount，只剩分类判据
  const needsReview = !o.categoryExact || bareAmount || verifyReview

  const reasons = [
    o.path === 'quick' ? 'quick' : 'ai',
    o.categoryExact ? 'category_exact' : 'category_fuzzy',
    hasUnit ? 'amount_unit' : 'amount_bare',
  ]
  if (verifyReview) reasons.push('verify_review')

  let confidence: Confidence = 'low'
  if (!needsReview) {
    if (o.path === 'quick' && o.categoryExact && hasUnit) {
      confidence = 'high'
    } else if (o.path === 'ai' && o.categoryExact && !verifyReview && hasUnit) {
      confidence = 'medium'
    }
  }

  return { confidence, confidence_reasons: reasons, needs_review: needsReview }
}
