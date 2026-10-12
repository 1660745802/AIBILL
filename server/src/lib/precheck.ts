/**
 * `precheck` 下发载荷（契约 docs/recognition-flow.md §3）
 *
 * 把服务端预筛判据（`ai/verify.ts` 的 tier 档位链）原样交给客户端，让它在**发请求前**
 * 就能拦掉同一批噪声、并用**同一条 `rule_id`** 计数 —— 这样 ⑤ 上报的
 * 「客户端拦了多少 / 有没有误杀」才与服务端那套口径可比。
 *
 * 设计要点（每条都有代价，写在这里免得后人重新踩）：
 *
 * 1. **只从这里派生，不写进 rules.json**：判据的唯一真源是 `ai/verify.ts` 的常量；
 *    若允许人往文件里抄一份，两份必然漂移（这就是「第三种口径」的来源）。
 *    发布时把本模块的输出并进 payload，`content_hash` 覆盖它 —— 所以代码里改了判据
 *    也会换 hash、客户端会重拉。
 *
 * 2. **rule_id = `precheck.` + 服务端 reason 名**（逐字拼接，不做任何改名）：
 *    `ai_parse_filters.reasons` 里存的就是 `coupon_facevalue` / `money+verb` 这些原字符串，
 *    所以「客户端 rule_id → 服务端 reason」是**机械前缀剥离**，不是一张会腐烂的映射表。
 *    id 里的 `+`（`precheck.money+verb`）刻意保留：改名就等于再次引入映射。
 *
 * 3. **本判据 channel 无关**：服务端不区分 nls/sms/a11y。客户端可在这条链**之前**
 *    先做自己的渠道门禁（自身通知/系统摘要/去重/熔断），那些拦截**不属于本清单**，
 *    按契约用 `client_only.<name>` 上报、不参与误杀率比较。
 *
 * 4. **只覆盖入站**：`precheck` 是「调模型之前」的判据。出站佐证（`verifyParsed` 的
 *    drop 理由）发生在模型调用之后，客户端不可能预先算出，故**不在本清单**、
 *    也不参与 ⑤ 的对比。
 */

import {
  INBOUND_SIGNAL_SOURCES,
  STRONG_NOISE_RULES,
  WEAK_NOISE_RULES,
} from '../ai/verify.js'

export type PrecheckRuleType = 'regex' | 'predicate' | 'fallback'

export interface PrecheckRule {
  /** `precheck.` + 服务端 reason 名（逐字拼接，客户端按它计数） */
  id: string
  /**
   * 命中该规则后的 tier（0/1/2/3/4，**恒为整数，没有 null**）。
   * 拦不拦不是看「有没有 tier」，而是看**链中第一条命中规则**的 tier：
   * `should_call_ai` = tier ∈ {1,2,3}（放行去调模型），tier ∈ {0,4} 才是拦。
   */
  tier: number
  type: PrecheckRuleType
  /** `type==='regex'` 时的正则源码（**不含**分隔符） */
  pattern?: string
  /** 正则 flags（`''` / `i` / `g` / `m` 的组合；连 pattern 一起用，别丢） */
  flags?: string
  /** `type==='predicate'` 时引用 signals 的表达式（如 `money && verb`） */
  expr?: string
  /** 语义说明：客户端要按它计数、也要按它解释「为什么这条没调 AI」 */
  desc: string
}

export interface PrecheckSignal {
  pattern: string
  /** ⚠️ 必读：`money` 是 `gi`，丢 flags 会让 `rmb 100` 两端不一致 */
  flags: string
}

export interface Precheck {
  /** 客户端不认识的 schema → 整体忽略并降级用本地词表 */
  schema: number
  /** 派生来源（改判据要改这里，不是改 rules.json） */
  derived_from: string
  /** 服务端判据不区分渠道；渠道门禁属客户端（`client_only.*`） */
  channel_agnostic: true
  /** 链所依赖的信号正则：客户端照此复现同一链（顺序即 rules 的顺序） */
  signals: {
    money: PrecheckSignal
    verb: PrecheckSignal
    bare_amount: PrecheckSignal
    /** 短句「光杆数字」的长度阈值：判据是 `input.trim().length <= 该值` */
    bare_amount_max_len: number
  }
  /** **顺序即判据顺序**：强噪声 → 金额+动词 → 弱噪声 → 仅金额 → 光杆数字 → 仅动词 → 无信号 */
  rules: PrecheckRule[]
  should_call_ai: string
  corroboration_required: string
}

const SCHEMA = 1

/** 链顺序对照（`classifyNotification` 的正文必须与此一致，测试会锁住） */
export function derivePrecheck(): Precheck {
  const { bare_amount_max_len: maxLen } = INBOUND_SIGNAL_SOURCES

  const rules: PrecheckRule[] = [
    // ① 强噪声：命中即丢，不看有没有金额
    ...STRONG_NOISE_RULES.map<PrecheckRule>((r) => ({
      id: `precheck.${r.name}`,
      tier: 0,
      type: 'regex' as const,
      pattern: r.pattern,
      flags: r.flags,
      desc: `强噪声（${r.name}）：命中即不调模型，即使文本里有金额`,
    })),
    // ② 正向信号优先于弱噪声（顺序不能换：换了会误杀真交易，见 WEAK_NOISE 注释）
    {
      id: 'precheck.money+verb',
      tier: 1,
      type: 'predicate',
      expr: 'money && verb',
      desc: '金额 + 交易动词 → 一定调模型',
    },
    // ③ 弱噪声：只在没有 ② 的正向信号时才生效
    ...WEAK_NOISE_RULES.map<PrecheckRule>((r) => ({
      id: `precheck.${r.name}`,
      tier: 0,
      type: 'regex' as const,
      pattern: r.pattern,
      flags: r.flags,
      desc: `弱噪声（${r.name}）：仅在没有 money+verb 正向信号时才拦`,
    })),
    // ④ 只有金额 → 调模型，但出站要过金额佐证
    {
      id: 'precheck.money_only',
      tier: 2,
      type: 'predicate',
      expr: 'money',
      desc: '只有金额 → 调模型，出站需金额佐证',
    },
    // ⑤ 短句里的光杆数字（「午饭32」）：也当金额信号，但同样要过佐证
    {
      id: 'precheck.bare_amount',
      tier: 2,
      type: 'predicate',
      expr: `len<=${maxLen} && bare_amount`,
      desc: `短句（≤${maxLen} 字）光杆数字 → 调模型，出站需金额佐证`,
    },
    // ⑥ 只有动词
    { id: 'precheck.verb_only', tier: 3, type: 'predicate', expr: 'verb', desc: '只有交易动词 → 调模型' },
    // ⑦ 兜底：无任何信号
    { id: 'precheck.no_signal', tier: 4, type: 'fallback', desc: '无任何信号 → 不调模型（兜底，排最后）' },
  ]

  return {
    schema: SCHEMA,
    derived_from: 'src/ai/verify.ts',
    channel_agnostic: true,
    signals: { ...INBOUND_SIGNAL_SOURCES },
    rules,
    should_call_ai: 'tier in (1,2,3)',
    corroboration_required: 'tier in (2,3)',
  }
}

/** 判据 id → 服务端 reason（机械前缀剥离；⑤ 对账靠它，不要改成映射表） */
export function precheckIdToReason(ruleId: string): string {
  return ruleId.startsWith('precheck.') ? ruleId.slice('precheck.'.length) : ruleId
}
