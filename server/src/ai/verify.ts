/**
 * 通知文本的机械校验层
 *
 * 这一层**不做语义判断**，只做可判定的字符串判定。分工是：
 *   - prompt / 模型负责「这是不是一笔交易」（语义，模型擅长）
 *   - 这一层负责「这个数字站不站得住」「这段文字是不是纯噪声」（确定性判定，模型不可靠）
 *
 * 为什么不能靠 prompt：让概率模型执行「金额必须带货币单位」这种确定性任务，
 * 每次都会漏。线上实测 W38 起 16 个无佐证金额里 13 个真的进了账本。
 *
 * 本文件里的所有规则都从真实数据反推，正反例见 tests/ai/verify.test.ts。
 * 改任何一条规则前先跑那两个测试。
 */

/** 账目项的最小形状（与 AI 返回、quickParse 返回兼容） */
export interface VerifyItem {
  type: string
  amount: number   // 单位：分
  description?: string
  date?: string
  [k: string]: unknown
}

export type Tier = 0 | 1 | 2 | 3 | 4

export interface ClassifyResult {
  /** 0/4 = 丢弃；1 = 正常调 AI；2/3 = 调 AI 但需要佐证 */
  tier: Tier
  reasons: string[]
}

/* ══════════════════════════════════════════════════════════
   一、金额抽取
   ══════════════════════════════════════════════════════════ */

/**
 * 抽出原文里「带货币单位」的金额集合（元为单位，保留 2 位）。
 *
 * 三个必须注意的地方，都是被真实数据打出来的：
 * 1. 千分位：先剥掉 `1,173.20` 的逗号，否则会抽成 173.2。
 *    剥的时候不能用 `\b` 收尾——Python/JS 里「元」是 \w，`\d{3}\b` 在
 *    `1,173元` 上不成立。（本项目是 TS，这里用 `(?!\d)` 等价写法。）
 * 2. 单位在数字**前**：`人民币2.00` / `RMB 100.00` 同样是有效写法。
 * 3. 只认 ¥￥ 与这些词，不认「分/角/毛」——通知里几乎不出现，误伤风险大于收益。
 * 4. 畸形数字必须抽不出值，而不是抽出错值（kiro 审查发现）：
 *    `2.555元` 曾被抽成 555（`.55` 匹配失败后正则回退到 `555元`），
 *    `1,23元` 曾被抽成 23，`3块5` 曾被抽成 3。
 *    做法：数字左侧不许紧邻数字/小数点/逗号（千分位剥完剩下的逗号就是畸形分组），
 *    单位右侧不许紧邻数字。
 */
const MONEY_RE = /[¥￥]\s*(\d+(?:\.\d{1,2})?)(?!\d)|(?:人民币|RMB|CNY)\s*(\d+(?:\.\d{1,2})?)(?!\d)|(?<![\d.,])(\d+(?:\.\d{1,2})?)\s*(?:元|圆|块钱|块|人民币|RMB|CNY)(?!\d)/gi

/** 剥掉千分位逗号：`1,173.20` → `1173.20` */
function stripThousands(s: string): string {
  return s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
}

/** 原文里所有「带货币单位」的金额（元） */
export function extractMoneyAmounts(rawInput: string): Set<number> {
  const text = stripThousands(rawInput || '')
  const out = new Set<number>()
  for (const m of text.matchAll(MONEY_RE)) {
    const g = m[1] ?? m[2] ?? m[3]
    if (g == null) continue
    const n = Number(g)
    if (Number.isFinite(n)) out.add(Math.round(n * 100) / 100)
  }
  return out
}

/* ══════════════════════════════════════════════════════════
   二、关键词匹配
   ══════════════════════════════════════════════════════════ */

/**
 * 数字感知的关键词匹配器。
 *
 * 中文没有词边界，朴素子串匹配会出灾难性误伤：
 *   `0元` 是 `3.90元` / `4.20元` / `16.90元` 的**子串**。
 * 第一版规则没加边界，直接把 213 条银行通知判成了营销文案。
 * 所以所有关键词前后都不能紧邻数字或小数点。
 */
function keyword(...words: string[]): RegExp {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(?<![\\d.])(?:${alt})(?![\\d.])`)
}

/**
 * 语义动词的匹配器：**不套数字边界**。
 *
 * 踩过的坑：把 keyword() 的右边界 `(?![\d.])` 也用在 `消费`/`扣款`/`到账` 上，
 * 结果 `招行信用卡消费32.50人民币` 判不出动词，被降成 tier2（money_only）。
 * 而「动词后面紧跟一个数字」恰恰是银行通知最常见的写法。
 *
 * 边界是为**带数字的关键词**（`0元`）准备的——防止它命中 `3.90元` 的子串。
 * 语义词不含数字，套边界只会造成漏判。
 */
function verb(...words: string[]): RegExp {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(?:${alt})`)
}

/** 交易动词：说明「这是一笔资金流动」 */
const PAYMENT_VERB = verb(
  '支付成功', '付款成功', '已支付', '扣款', '扣费', '消费', '到账', '入账', '收款',
  '转账', '退款', '缴费', '还款', '充值', '代扣', '已付', '支出', '付款', '免密',
  '快捷支付', '动账', '入账工资',
)

/**
 * 强噪声：命中即丢，不看有没有金额。
 * 只放「即使文本里有金额也绝不可能是一笔新交易」的形态。
 */
const STRONG_NOISE: { name: string; re: RegExp }[] = [
  // 社交红包：金额数字来自群名/昵称（线上真实案例：`209[嗨] [QQ红包]...` → 记成 ¥209）
  { name: 'social_redpacket', re: /\[(?:QQ|微信|支付宝)红包\]|群发红包|口令红包|红包\s*[:：]/ },
  // App 自身的统计通知回环（线上真实案例：`【记账日报】昨日支出220.00元，共2笔` → 被拆成 110+110）
  // 注意：这里只认 App 自己的报表标记，不认通用的「共N笔」——那个归 fabricated_split 管，
  // 两者混在一起会让平摊检测这条路径永远走不到（真踩过）。
  { name: 'self_report', re: /记账日报|昨日支出|本月支出|本周支出|上周支出/ },
  // 订单状态推送：这笔已经记过了，这条只是状态更新
  { name: 'order_state', re: keyword('加入购物车', '立即购买', '去支付', '确认订单', '查看物流', '再次购买', '已签收', '待发货', '待收货', '提交订单', '交易已取消', '申请售后') },
  // 垃圾短信
  { name: 'spam_sms', re: keyword('退订', '贷款', '借款', '提额', '回复TD', '点击链接') },
]

/**
 * 弱噪声：只在**没有正向信号**时才生效。
 * 曾经让弱噪声压过正向信号，结果误杀了
 * `支付成功 ￥30.26 支付成功 回首页 好想来零食乐园 完成`（`首页` 命中了）。
 */
const WEAK_NOISE: { name: string; re: RegExp }[] = [
  { name: 'marketing', re: keyword('双11', '双十一', '开抢', '预售', '加赠', '赠品', '优惠券', '神券', '秒杀', '满减', '立减', '直降', '到手', '价保', '返现', '一分钱', '一分钱领') },
  // 0 元诱导：`0元领` `0元兑` `0元购`；`0元` 必须带前后边界，否则命中 `3.90元`
  { name: 'zero_yuan', re: /(?<![\d.])0\s*元(?:兑|领|购|买|花|起|下单|抽奖)(?![\d.])/ },
  { name: 'unrelated', re: keyword('点赞', '关注', '转发', '群发', '朋友圈', '聊天', '视频通话', '直播', '首页', '空间') },
]

/* ══════════════════════════════════════════════════════════
   三、分流
   ══════════════════════════════════════════════════════════ */

/**
 * 把一条通知分到 5 个档之一。
 *
 *   档 1  有带单位金额 + 交易动词  → 正常调 AI
 *   档 2  仅金额                  → 调 AI，但出结果后要过佐证
 *   档 3  仅交易动词（无金额）     → 调 AI，但出结果后要过佐证
 *   档 0  命中强噪声              → 不调 AI
 *   档 4  无任何信号              → 不调 AI
 *
 * 顺序很重要：**正向信号优先于弱噪声**。理由见 WEAK_NOISE 注释。
 */
export function classifyNotification(rawInput: string): ClassifyResult {
  const text = rawInput || ''

  const strong = STRONG_NOISE.find((r) => r.re.test(text))
  if (strong) return { tier: 0, reasons: [strong.name] }

  const hasMoney = extractMoneyAmounts(text).size > 0
  const hasVerb = PAYMENT_VERB.test(text)

  if (hasMoney && hasVerb) return { tier: 1, reasons: ['money+verb'] }

  const weak = WEAK_NOISE.find((r) => r.re.test(text))
  if (weak) return { tier: 0, reasons: [weak.name] }

  if (hasMoney) return { tier: 2, reasons: ['money_only'] }
  if (hasVerb) return { tier: 3, reasons: ['verb_only'] }
  return { tier: 4, reasons: ['no_signal'] }
}

/** 该不该为这条文本调用模型 */
export function shouldCallAi(c: ClassifyResult): boolean {
  return c.tier === 1 || c.tier === 2 || c.tier === 3
}

/** 该不该在解析结果出来后强制做金额佐证 */
export function requiresCorroboration(c: ClassifyResult): boolean {
  return c.tier === 2 || c.tier === 3
}

/* ══════════════════════════════════════════════════════════
   四、金额佐证 + 两条硬规则
   ══════════════════════════════════════════════════════════ */

/** 金额是否在原文里带货币单位出现过 */
export function hasCorroboration(rawInput: string, amountCents: number): boolean {
  if (!Number.isFinite(amountCents)) return false
  return extractMoneyAmounts(rawInput).has(Math.round(amountCents / 100 * 100) / 100)
}

/**
 * 卡号 / 尾号 / 单号 / 验证码 / 群名后面的数字，不是金额。
 *
 * 线上真实事故：`招商银行 信用卡通知：您尾号1678的招行信用卡消费1.00人民币。`
 * AI 给出 amount=167800（¥1,678.00）——把卡号尾号当成了金额。
 * 客户端 v1.5.14 修过同类问题（`209[嗨] [QQ红包]`），服务端一直没补。
 */
const NON_AMOUNT_NUMBER = new RegExp(
  '(?:尾号|卡号|尾数|单号|订单号|流水号|验证码|校验码|群名|QQ号?|工号)'
  + '\\s*[:：]?\\s*(\\d+(?:\\.\\d{1,2})?)',
  'g',
)

/**
 * 群名本身就是一串数字的写法：`209[嗨] [QQ红包]...`。
 * 这种数字在前面，所以上面的「关键词在前」模式匹配不到，要单独兜。
 */
const LEADING_DIGIT_GROUP = /^\s*(\d{1,6})\s*[[【][^\]】]{0,20}[\]】]/

/** AI 给出的金额是否正好等于一个「非金额数字」（卡号尾号、群名等） */
export function amountIsNonAmountDigit(rawInput: string, amountCents: number): boolean {
  const target = amountCents / 100
  for (const m of (rawInput || '').matchAll(NON_AMOUNT_NUMBER)) {
    if (Math.abs(Number(m[1]) - target) < 0.005) return true
  }
  const lead = (rawInput || '').match(LEADING_DIGIT_GROUP)
  if (lead && Math.abs(Number(lead[1]) - target) < 0.005) return true
  return false
}

/**
 * `共N笔` 的句式里，那个金额是**总额**，不是单笔。
 * AI 会把它按笔数平摊（线上真实事故：
 * `【记账日报】昨天共有2笔支出 昨日支出220.00元，共2笔` → 被拆成 110 + 110）。
 */
const TOTAL_WITH_COUNT = /(?:共|合计|总计)\s*(\d+)\s*笔/

/** AI 是否把一个总额按笔数平摊了 */
export function isFabricatedSplit(rawInput: string, items: VerifyItem[]): boolean {
  const m = (rawInput || '').match(TOTAL_WITH_COUNT)
  if (!m || items.length < 2) return false
  const count = Number(m[1])
  if (count !== items.length) return false
  const amounts = items.map((i) => i.amount)
  // 每一笔都相等，且都等于原文总额/笔数
  const first = amounts[0]
  if (amounts.some((a) => a !== first)) return false
  const total = first * count
  return extractMoneyAmounts(rawInput).has(Math.round(total / 100 * 100) / 100)
}

/* ══════════════════════════════════════════════════════════
   五、组合入口
   ══════════════════════════════════════════════════════════ */

export type VerifyVerdict = 'pass' | 'drop' | 'review'

export interface VerifyResult {
  verdict: VerifyVerdict
  reason: string
  /** 逐条判定，key 是该项在数组里的下标 */
  perItem: Record<number, { verdict: VerifyVerdict; reason: string }>
}

/**
 * 对 AI 的解析结果做机械校验（方案 B）。
 *
 * B 的边界很清楚：**只丢「确定是噪声」的，不动「看起来像真交易」的**。
 * 判定依据是文本形态，不是金额佐证——
 * `订单已消费 您的订单【小铁台球】39.9两小时中八已成功消费` 里的 39.9
 * 后面没有货币单位，但它是一笔真实消费（线上已落地），必须放行给客户端。
 */
export function verifyParsed(rawInput: string, items: VerifyItem[], requireCorroboration: boolean): VerifyResult {
  const perItem: VerifyResult['perItem'] = {}

  // 整段就是自通知 / 红包 / 订单态 → 全部丢
  const c = classifyNotification(rawInput)
  if (c.tier === 0) {
    items.forEach((_, i) => { perItem[i] = { verdict: 'drop', reason: c.reasons[0] } })
    return { verdict: 'drop', reason: c.reasons[0]!, perItem }
  }

  // 整段没有信号但 AI 居然抽出了金额 → 丢
  if (c.tier === 4) {
    items.forEach((_, i) => { perItem[i] = { verdict: 'drop', reason: 'no_signal' } })
    return { verdict: 'drop', reason: 'no_signal', perItem }
  }

  // 总额被按笔数平摊 → 整段丢
  if (isFabricatedSplit(rawInput, items)) {
    items.forEach((_, i) => { perItem[i] = { verdict: 'drop', reason: 'fabricated_split' } })
    return { verdict: 'drop', reason: 'fabricated_split', perItem }
  }

  let anyReview = false
  items.forEach((item, i) => {
    // 只有当这个数字**没有货币单位佐证**时，才认定它是卡号尾号。
    // `尾号1678…消费1678.00元` 这种「尾号恰好等于消费额」是真交易
    // （尾号 4 位、消费额几百上千，撞上不罕见）——kiro 审查实测发现原实现
    // 会把它无条件 drop，丢的是真钱。原事故（尾号1678 → ¥1,678）里
    // 1,678.00 没有佐证，仍然会被拦下。
    if (amountIsNonAmountDigit(rawInput, item.amount)
        && !hasCorroboration(rawInput, item.amount)) {
      perItem[i] = { verdict: 'drop', reason: 'card_digit_as_amount' }
      return
    }
    if (requireCorroboration && !hasCorroboration(rawInput, item.amount)) {
      perItem[i] = { verdict: 'review', reason: 'no_corroboration' }
      anyReview = true
      return
    }
    perItem[i] = { verdict: 'pass', reason: 'ok' }
  })

  const dropped = Object.values(perItem).filter((v) => v.verdict === 'drop').length
  if (dropped === items.length) {
    return { verdict: 'drop', reason: perItem[0]!.reason, perItem }
  }
  if (anyReview) return { verdict: 'review', reason: 'no_corroboration', perItem }
  return { verdict: 'pass', reason: 'ok', perItem }
}
