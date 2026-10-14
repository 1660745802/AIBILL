/**
 * 判据 C6/C7 的 rules.json 那一侧：显式豁免清单 + 入参拼装（纯函数、无 IO）
 *
 * 与 criterion-consistency.ts 的分工：那边是判据与 fail-fast 入口，这边只负责
 * 「把 rules.json（已解析好的对象）翻译成 C6/C7 要的入参」——读文件由挂载点做。
 * 拆成独立文件是为了守住 ARCHITECTURE §4.2 的 300 行上限。
 *
 * ⚠️ 这里只 import **类型**（编译后抹掉），运行时不会与入口成环。
 */
import { INBOUND_SIGNAL_SOURCES } from './verify.js'
import { plainRuns } from './noise-terms-drift.js'
import type { RulesCriterionInput } from './criterion-consistency.js'

/**
 * C6 的**显式豁免清单**：客户端拦截词与服务端正向词的已知重叠。
 *
 * 为什么必须有它：rules.json 是**客户端宽松召回层**，它的排除词按子串匹配，
 * 而服务端 `payment_signal_regex` / `PAYMENT_VERB` 里的正向词（支付/付款/退款…）
 * 会被这些更长的词「包含」——两者共存是设计使然（§3.3 C6），不是 bug。
 * 豁免必须**显式登记**（不许通配、不许「按前缀」），每条写清为什么。
 *
 * ⚠️ 下面每条的「现状」一栏记录的是它**今天是否真的被 C6 命中**：
 * 命中的（7 条 A11Y 排除词）与登记但不命中的（退订/回T/恭喜/申请/退款）
 * 都要写——后者是「将来客户端词表一改就可能命中」的预登记，删掉它们等于把
 * 下一次漂移变成一次线上事故。
 */
export const ALLOWED_OVERLAPS: ReadonlyArray<{ readonly term: string; readonly why: string }> = [
  {
    term: '退款成功',
    why: 'A11Y 订单页的「退款成功」按钮/状态文案，客户端按子串拦页面；服务端把「退款」当'
      + '正向信号是因为真实通知里确有「退款到账200元」。两者语境不同（A11Y 页面 vs 银行/支付'
      + '通知），靠渠道（a11y vs sms/nls）区分，不是同一个输入集合。现状：**命中 C6**。',
  },
  {
    term: '申请退款',
    why: '同上：A11Y 页面上的「申请退款」入口。真实的退款通知写的是「退款到账/退款成功」，'
      + '不含「申请」二字。现状：**命中 C6**。',
  },
  {
    term: '去支付',
    why: 'A11Y 支付页的「去支付」按钮文案。服务端「支付」正向针对的是通知正文（支付成功/已支付），'
      + '不是这个按钮。现状：**命中 C6**。',
  },
  {
    term: '立即付款',
    why: '同上，A11Y 页面按钮文案。现状：**命中 C6**。',
  },
  {
    term: '极速付款',
    why: '同上，A11Y 页面按钮文案。现状：**命中 C6**。',
  },
  {
    term: '确认付款',
    why: '同上，A11Y 页面按钮文案。现状：**命中 C6**。',
  },
  {
    term: '更改付款方式',
    why: '同上，A11Y 页面按钮文案。现状：**命中 C6**。',
  },
  {
    term: '退订',
    why: '短信退订尾巴（`…退订回T`）出现在**每一封**银行通知里，客户端按它无条件拦短信通道；'
      + '服务端 `precheck.spam_sms` 是**弱**噪声（有 money+verb 时先放行），所以同一条短信'
      + '两端口径不同、且严的那端没有兜底（设计 §7.2 B1 记录的现场）。'
      + '本次**不修**（要修得改客户端词表或改分层，属另一步），先登记豁免让断言不响。'
      + '现状：登记但今天不命中（`退订` 不在服务端正向词表里）。',
  },
  {
    term: '回T',
    why: '与「退订」同一条尾巴的另一种写法（`退订回T` / `回复R`）。同样先登记。'
      + '现状：登记但今天不命中。',
  },
  {
    term: '恭喜',
    why: '`sms.spam_keywords` 含「恭喜」，而服务端券面额语境也含「恭喜」（「恭喜获得…红包」）。'
      + '真实收入句式不会带「恭喜」，但两侧都认它时就会出现「一边拦一边认」。'
      + '现状：登记但今天不命中（服务端正向词表里没有「恭喜」）。',
  },
  {
    term: '申请',
    why: '`sms.spam_keywords` 含「申请」，银行短信里的「申请/审批」类文案很常见；'
      + '它是「客户排除词过宽」的典型样本。现状：登记但今天不命中。',
  },
  {
    term: '退款',
    why: '服务端把「退款」当正向信号（真实收入：退款到账200元），而客户端多处排除词含「退款」。'
      + '豁免的是**客户端那几条具体词**（已在上方逐条登记），这里登记单词「退款」本身，'
      + '是为了将来客户端新增裸词「退款」时不再需要临时改代码。现状：登记但今天不命中。',
  },
  {
    term: '交易已取消',
    why: 'A11Y 订单页的「交易已取消」状态文案，客户端按子串拦整页；服务端把「交易」当正向信号'
      + '是因为银行/支付通知里「交易成功/交易金额」真实存在（长 payment_signal_regex 含「交易」）。'
      + '被拦的是「已取消」这个后缀（取消的不是账），所以无害。'
      + '现状：**命中 C6**（补回长 payment_signal_regex 后）。',
  },
  {
    term: '红包雨',
    why: '「红包雨」是营销活动词（雨 = 批量派发），不是到账；服务端把「红包」当正向信号'
      + '是因为真实「收到XX红包」是收入。靠「雨」这个后缀区分，不是同一个输入集合。'
      + '现状：**命中 C6**（补回长 payment_signal_regex 后）。',
  },
]

/** 从 rules.json 的四个客户端拦截词表里收集（键缺失/类型不对一律当作空，不静默补默认值） */
function collectClientBlockKeywords(rules: unknown): Array<{ term: string; where: string }> {
  const r = (rules ?? {}) as Record<string, unknown>
  const pick = (section: string, key: string): string[] => {
    const sec = r[section]
    const list = sec && typeof sec === 'object'
      ? (sec as Record<string, unknown>)[key]
      : undefined
    if (!Array.isArray(list)) return []
    return list.filter((x): x is string => typeof x === 'string')
  }
  const sources: ReadonlyArray<[string, string, string]> = [
    ['a11y', 'common_exclude_keywords', 'a11y.common_exclude_keywords'],
    ['a11y', 'wechat_alipay_exclude_keywords', 'a11y.wechat_alipay_exclude_keywords'],
    ['sms', 'spam_keywords', 'sms.spam_keywords'],
    ['processor', 'marketing_suffix_cutoffs', 'processor.marketing_suffix_cutoffs'],
  ]
  return sources.flatMap(([section, key, where]) =>
    pick(section, key).map((term) => ({ term, where })))
}

/**
 * 服务端正向判据的字面量 token：`nls.payment_signal_regex` ∪ `PAYMENT_VERB`。
 *
 * 口径与 rules.json 下发给客户端的那份一致（同一个 `payment_signal_regex` 字符串），
 * 加上服务端自己的交易动词表——两者都是「这段文本像是一笔账」的判据。
 */
function serverPositiveTokens(rules: unknown): string[] {
  const r = (rules ?? {}) as Record<string, unknown>
  const nls = (r.nls ?? {}) as Record<string, unknown>
  const signal = typeof nls.payment_signal_regex === 'string' ? nls.payment_signal_regex : ''
  return [...new Set([
    ...plainRuns(signal),
    ...plainRuns(INBOUND_SIGNAL_SOURCES.verb.pattern),
  ])].sort()
}

/**
 * 由 rules.json（已解析好的对象）拼出 C6/C7 需要的入参。**本模块不碰 IO**，
 * 读文件由挂载点（lib/notification-rules.ts / routes/notification-rules.ts）做。
 */
export function rulesCriterionSlice(rules: unknown): RulesCriterionInput {
  const r = (rules ?? {}) as Record<string, unknown>
  const rawCases = Array.isArray(r.testcases) ? r.testcases : []
  const testcases = rawCases
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      id: typeof c.id === 'string' ? c.id : String(c.id ?? ''),
      expect_txn: c.expect_txn === true,
      expect_client: typeof c.expect_client === 'string' ? c.expect_client : undefined,
    }))
  return {
    clientBlockKeywords: collectClientBlockKeywords(rules),
    serverPositiveTokens: serverPositiveTokens(rules),
    allowedOverlaps: ALLOWED_OVERLAPS,
    testcases,
  }
}
