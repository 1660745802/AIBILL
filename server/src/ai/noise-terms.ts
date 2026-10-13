/**
 * 噪声判据的**结构化形态**（候选 06 · Step 0，零行为变更）
 *
 * 现状：噪声是 `verify.ts` 里两组正则（STRONG_NOISE / WEAK_NOISE），能回答
 * 「这段文本是不是噪声」，但**回答不了「哪个词让它变成噪声」**——
 * 于是「红包」既是噪声模式、又是收入种子分类名、又是同义词表的键，
 * 三处各自硬编码，谁也不知道谁（grep 实测「红包」在服务端散落 5 处）。
 *
 * 这里把「词 + 必填语境」二元组显式化，供后续 matcher 的噪声闸（设计 §2.1 L1）消费：
 *   · term    —— 触发词（中文没有词边界，按子串匹配）
 *   · context —— **必填**语境正则；term 与 context **同时**命中原文才算噪声
 *   · reason  —— 写进审计串的名字，与 verify 的规则名对齐
 *
 * 铁律：**裸词永不判噪声**。用户自建的分类名（优惠券/红包…）只与「裸词」竞争，
 * 不与「带语境判据」竞争 → 「用户建了个叫红包的收入分类，手打「红包100」」
 * 不触发噪声（无券语境），走 exact 正常记账（设计 §3.5，误报面 = 0）。
 *
 * ⚠️ `verify.ts` 的 STRONG/WEAK 正则一行未改，`classifyNotification` 的行为与
 * Step 0 之前逐字相同；本表的 `judgeNoise` 是**归类层新增**的独立入口（Step 4 接线），
 * 与分流层的关系写在文件末尾的注释里。
 *
 * 为什么单独成文件而不是塞进 verify.ts：verify.ts 已 436 行，超了
 * ARCHITECTURE §4.2 的 300 行上限，再加只会更糟；而且这批词条是**归类层**的输入
 * （设计 §2.1 L1 写在 category-matcher.ts 里），单独成文件让「真源」有唯一落点。
 */

/** 噪声词条：词 + 必填语境。缺 context 的条目永远判不了噪声（C5 会报出来） */
export interface NoiseTerm {
  readonly term: string
  /** 必填语境；不带 g/y（stateful 正则的 lastIndex 会让「同一段原文第二次判不出」） */
  readonly context: RegExp
  /** 审计名，与 verify.ts 的规则名对齐 */
  readonly reason: string
  /**
   * **审计用，不参与判定**：verify.ts `STRONG_NOISE_RULES.coupon_facevalue` 的宽语境。
   * 只给券/卡类词条配（它们在分流层有对应的宽口径规则）。
   *
   * 用途：Step 4 决策「窄语境不扩宽，但要让判例可复核」——当一个词条在**窄语境下
   * 不命中、宽语境下会命中**时（例如 `优惠券50`：窄语境不含「优惠」），把这笔标成
   * 「宽口径会给出不同答案」，由管理员事后复核，而不是当场杀。
   */
  readonly broadContext?: RegExp
}

/**
 * 券面额 / 营销语境。
 *
 * 全部来自 verify.ts `coupon_facevalue` 那条正则里**已经出现过**的词，
 * **一个都没新增**（新增语境 = 新判据 = 要另开一次线上验证）。
 *
 * ⚠️ 刻意**比 verify 那条正则更窄**：剔除了 领取 / 优惠 / 获得 / 专属 / 点击参与。
 * 理由是这张表的**消费方不同**：
 *   · `【微信】你领取了好友的红包 8.88元` —— 真实收入，掉了就是丢账；
 *   · `优惠券50` —— 用户手打的分类名，判噪声就等于误杀一条真账（设计 §3.5 的零误报面）；
 *   verify 侧的 STRONG 那条保留宽口径即可（那里「宁杀勿错」成立）。
 * 另外刻意**不含**「到账 / 已存入 / 收款」：真实红包落账句式不能被它挡。
 */
const COUPON_CONTEXT =
  /(?:失效|过期|作废|到期|待领|待查收|未查收|未领取|满减|最高减|直减|去领|名额有限|受邀|恭喜|即将|提醒)/

/**
 * 招募 / 奖励广告语境（来自 verify.ts `reward_ad` 与 `coupon_facevalue` 的奖励支路）。
 * 这里可以保留 获得 / 恭喜 / 专属：它只挂在**卡类**词条上，真实红包句式不会说到京东卡。
 */
const REWARD_CONTEXT =
  /(?:访谈|调研|问卷|招募|寻找玩家|内测|公测|试玩|任务奖励|领取奖励|加群|扫码进群|推广|代理|加盟|获得|恭喜|受邀|名额有限|点击参与)/

/** 「等你来领」类邀约的宾语（券本身），用于待领取/未查收那一族 */
const CLAIMABLE = /(?:红包|券|立减金|额度|优惠券|礼品卡|购物卡)/

/**
 * 宽语境（**仅审计用，不参与判定**）：verify.ts `STRONG_NOISE_RULES.coupon_facevalue`
 * 的语境词集合，与上面 COUPON_CONTEXT 的差别就是 领取 / 优惠 / 获得 / 专属 / 点击参与。
 *
 * 为什么把它搬一份到这里而不是让代码去读 verify 的正则：
 * verify 的正则是**一个大 alternation**（券名词…语境 / 语境…券名词 两个方向），
 * 拿它做「单词条 + 单语境」的比对需要拆解，拆出来的中间态没法当契约用。
 * 这里只保留**语境词集合**这一个事实，方向在 verify 那侧保持不变。
 */
const BROAD_COUPON_CONTEXT =
  /(?:最高减|满减|直减|领取|去领|获得|恭喜|受邀|优惠|专属|失效|过期|作废|到期|待领|即将|名额有限|点击参与)/

/**
 * 噪声词表。**只有两类**：① 券面额 / 广告 ② 待领取 / 未查收类邀约（设计 §2.1 L1）。
 *
 * 刻意**不含**「余额」：`您的账户余额为1000.00元` 在分流层是 tier2 money_only，
 * 由 verify 的佐证与 prompt 判；归类层不为它做主判（两处主判会漂成第三处真相）。
 */
export const NOISE_TERMS: readonly NoiseTerm[] = [
  // ① 券面额 / 广告（券名词 + 邀约/发放语境同现 → 面额不是到账金额）
  { term: '红包', context: COUPON_CONTEXT, reason: 'coupon_facevalue', broadContext: BROAD_COUPON_CONTEXT },
  { term: '立减金', context: COUPON_CONTEXT, reason: 'coupon_facevalue', broadContext: BROAD_COUPON_CONTEXT },
  { term: '优惠券', context: COUPON_CONTEXT, reason: 'coupon_facevalue', broadContext: BROAD_COUPON_CONTEXT },
  { term: '卡券', context: COUPON_CONTEXT, reason: 'coupon_facevalue', broadContext: BROAD_COUPON_CONTEXT },
  { term: '券', context: COUPON_CONTEXT, reason: 'coupon_facevalue', broadContext: BROAD_COUPON_CONTEXT },
  { term: '京东卡', context: REWARD_CONTEXT, reason: 'reward_ad' },
  { term: '购物卡', context: REWARD_CONTEXT, reason: 'reward_ad' },
  { term: '礼品卡', context: REWARD_CONTEXT, reason: 'reward_ad' },
  // ② 待领取 / 未查收类邀约：词本身已是「没到手」的信号，但仍要求宾语（券）在场，
  //    否则用户说「待领取的快递」会被误杀。
  { term: '待领取', context: CLAIMABLE, reason: 'promo_unclaimed' },
  { term: '未领取', context: CLAIMABLE, reason: 'promo_unclaimed' },
  { term: '未查收', context: CLAIMABLE, reason: 'promo_unclaimed' },
  { term: '待查收', context: CLAIMABLE, reason: 'promo_unclaimed' },
]

/* ══ 噪声闸（L1）：唯一的判定入口 ═══════════════════════════════════════ */

/**
 * 这次噪声判定属于哪一类（审计用，Step 4 产品决策：「先不改语境宽度，但记下来」）：
 *   · `'narrow'` —— **被噪声闸判掉了**。`term` 记命中哪个词条。
 *   · `'broad'`  —— 窄语境**放过了**，但按 verify 的宽口径会判噪声。
 *     例：`优惠券50`（用户手打分类名）——这类判例不当场杀，标出来给管理员复核。
 *   · `null`     —— 两种口径结论一致，不需要人工看（绝大多数账都是这一类）。
 */
export type NoiseVerdictSource = 'narrow' | 'broad' | null

/** 归类结果里带的噪声审计（`null` = 两种口径一致，不需要人工看） */
export interface NoiseAudit {
  /** 命中的噪声词条；`source==='broad'` 时为 null（窄语境没命中） */
  readonly term: string | null
  readonly source: Exclude<NoiseVerdictSource, null>
}

export interface NoiseVerdict {
  /** 噪声闸的实际命中（窄语境）；null = 不判噪声 */
  readonly hit: { readonly term: string; readonly reason: string } | null
  readonly source: NoiseVerdictSource
}

const EMPTY_VERDICT: NoiseVerdict = { hit: null, source: null }

/** 命中的词条取「最长的那个」（更具体的词优先），等长按码位序，避免依赖词表书写顺序 */
function pickLongest(hits: readonly NoiseTerm[]): NoiseTerm | null {
  if (hits.length === 0) return null
  const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const sorted = [...hits].sort((a, b) => b.term.length - a.term.length || byCodepoint(a.term, b.term))
  return sorted[0]!
}

/** 词 + 语境同时在原文里出现才算命中（裸词永不判噪声：必须有语境） */
function hitsWith(requested: string, evidenceText: string, broad: boolean): NoiseTerm[] {
  return NOISE_TERMS.filter((n) => {
    if (!requested.includes(n.term)) return false
    const context = broad ? (n.broadContext ?? n.context) : n.context
    return context.test(evidenceText)
  })
}

/**
 * 噪声闸判定：**词（requested） + 语境（evidenceText）同时命中**才算噪声。
 *
 * 裸词永不判噪声：`evidenceText` 缺失/为空时直接返回「不判」，不给任何词条豁免。
 * 模型只会吐「红包」两个字，无从表达语境——所以必须回原文取语境，缺原文就不判
 * （宁可漏拦，也不误杀真实收入）。
 */
export function judgeNoise(requested: string, evidenceText: string | undefined): NoiseVerdict {
  if (!evidenceText) return EMPTY_VERDICT
  const narrow = pickLongest(hitsWith(requested, evidenceText, false))
  if (narrow) {
    return { hit: { term: narrow.term, reason: narrow.reason }, source: 'narrow' }
  }
  const broad = pickLongest(hitsWith(requested, evidenceText, true))
  if (broad) return { hit: null, source: 'broad' }
  return EMPTY_VERDICT
}

/**
 * ⚠️ **不要把这两层合并**（设计 §3.6）：
 *   · `verify.ts` 的 STRONG_NOISE 在**分流层**——模型调用之前、整段文本判定，
 *     口径刻意偏宽（宁杀勿错），命中即丢弃，不会给任何分类机会。
 *   · 本表的 NOISE_TERMS 在**归类层**——模型之后、只看「它给的分类名 + 原文语境」，
 *     口径刻意偏窄（误杀 = 丢真账），只兜「这张通知明确是券面额/待领取」。
 *   两层的唯一交集是纵深防御：防绕过 STRONG 的渠道（换渠道、改文案）与未来新增的
 *   pass-through 路径（如 CSV 导入、AI 直调）。实测 §0.7 的 7 条广告在分流层已 7/7 拦下，
 *   但 `淘宝闪购10元红包未查收` 这种「未查收」句式**分流层漏过**（其语境词表没有
 *   未查收/未领取），只能靠这一层兜。
 */