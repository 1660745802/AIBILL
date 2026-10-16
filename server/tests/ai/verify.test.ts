/**
 * 机械校验层单元测试
 *
 * 所有正反例都取自线上真实数据（`ai_parse_logs.raw_input`），
 * 不是编的。改动 verify.ts 任何规则前先跑这个文件。
 *
 * 两条血泪教训在这里各有一个专门的用例：
 *   1. `0元` 是 `3.90元` 的子串 → 没加数字边界会误杀 213 条银行通知
 *   2. 弱噪声压过正向信号 → 误杀「支付成功 ￥30.26 回首页 好想来零食乐园」
 */
import { describe, it, expect } from 'vitest'
import {
  extractMoneyAmounts,
  classifyNotification,
  shouldCallAi,
  requiresCorroboration,
  hasCorroboration,
  amountIsNonAmountDigit,
  isFabricatedSplit,
  verifyParsed,
} from '../../src/ai/verify.js'

/* ── 真实语料 ─────────────────────────────────────────── */

// 银行 / 支付通知：全部必须判为「调 AI」
const REAL_TXNS = [
  ['招商银行 信用卡通知：您尾号1678的招行信用卡消费32.50人民币。', 3250],
  ['交易提醒 你在友宝有一笔3.90元的免密/自动扣款支付，', 390],
  ['动账提醒 您尾号2256的储蓄账户8月1日9时58分支出人民币4.20元。', 420],
  ['交易提醒 你有一笔16.90元的支出，领最高2.7元满5元提现。', 1690],
  ['工商银行 尾号9766卡9月30日16:16网上银行收入(工资)2,720元，余额25,210.99元。', 272000],
  ['工商银行 尾号9766卡10月5日18:28手机银行支出(跨行汇款)1,000元，余额24,210.99元。', 100000],
  ['招商银行 【招商银行】您账户2415于10月08日14:01入账工资，人民币14322.83。', 1432283],
  ['微信支付 已支付¥32.50', 3250],
  ['支付成功 ￥30.26 支付成功 回首页 好想来零食乐园 完成', 3026],
  ['支付成功 ￥62.17 支付成功 回首页 重庆永辉超市有限公司 付款方式', 6217],
] as const

/**
 * 「必须调 AI」但**金额本来就没有货币单位佐证**的真交易。
 * 它们是方案 B 的边界：不能丢，只能放行给客户端。
 * 来源：`订单已消费 您的订单【小铁台球】39.9…已成功消费。` —— 这条线上已落地。
 */
const REAL_TXN_NO_CORROBORATION = [
  '订单已消费 您的订单【小铁台球】39.9两小时中八（周末、节假日通用）已成功消费。',
] as const

// 纯噪声：必须判为「不调 AI」
const NOISE = [
  '【支付宝芭芭农场】一分钱领一箱水果 自种自吃，比网上买更放心',
  '【1分钱解锁5折乘车】 支付1分钱',
  '🧧双11省钱卡已开抢！ 双11省钱卡花3得29，一笔回本🔥加赠99积分0元兑云音乐月卡👉',
  '209[嗨] [QQ红包]太越林全员老公型: [红包]国庆快乐',
  '【记账日报】昨天共有2笔支出 昨日支出220.00元，共2笔',
  '【记账日报】昨日消费支出比平日高500.77% 昨日支出1868.98元，共2笔',
  'shu uemura植村秀官方旗舰店 叮咚！您的优惠券已送达 叠美妆券+88VIP券满额至高减￥270元',
  '😍1号会员日来啦 🛒12包抽纸0元领千份放量！ 🔥实付159元再享40元红包返利>',
  '您有闪购外卖红包未查收',
  '您有一个红包未领取 速来淘宝闪购！',
  '本次行程已结束 下车检查带好随身物品，点击确认您的账单。',
  // 以下四条是「券面额被当成到账金额」的一组线上真实事故。
  // 1444 条生产日志里有 30 条含「红包」，其中 18 条被编成 income（60%），
  // 根因：老 social_redpacket 只认 `[QQ红包]` / `红包：` 这两种带括号或冒号的写法，
  // 而真实通知绝大多数是「10元红包」这种平铺写法，一个都拦不住。
  '支付宝卡包 你有淘宝闪购10元红包今晚失效',
  '支付宝卡包 你有天天秒杀15.00元红包今晚失效',
  '支付宝卡包 你有淘宝闪购无门槛5元红包今晚失效',
  '你的现金红包即将过期 你在奶兔星球有6元现金红包再不用就来不及了',
  '【缴费有惊喜】 受邀用户领5元话费红包，名额有限，点击参与>>',
  '缴费小美好 缴费达标领至高5元微信立减金。',
  '滴滴酒店：专属优惠到账 恭喜获得酒店最高减200元券',
  // 招募/活动广告承诺的奖励不是到账金额（真事故：记入 ¥200 虚增收入）
  '在线寻找手游玩家 参加访谈任务，获得 200 元京东卡！',
  // 仪表盘式读数：网速/流量/下载进度。真事故：Clash 每分钟一条，24h 内 319 条
  // 全部空结果、占当天解析日志 94%，打爆 20 次/分钟限流并打出 3 次 60s 超时 504。
  // 它们全靠 `bare_amount`（tier2：24~30 字 + 光杆数字）漏进来的。
  'konghonglee 916B/s↑ 430B/s↓',
  'konghonglee 5.6KB/s↑ 60.0KB/s↓',
  'konghonglee 0B/s↑ 48B/s↓',
  '正在下载拼多多 迅雷正在加速 100%',
  // 订单/配送状态推进：真事故是一笔外卖订单烧了 7 条 AI 调用
  // （订单自动取消 + 商家接单 + 骑士接单 + 骑士正在配送×4），全部空结果。
  '订单将在12:15自动取消 等待支付',
  '预计12:33送达 商家已接单',
  '预计12:33送达 骑士已接单',
  '预计12:33送达 骑士正在配送',
] as const

/**
 * 「出现红包/券」不等于噪声——真实收红包必须放行。
 * 这条比「拦住多少」更重要：拦错一条就是丢收入。
 * coupon_facevalue 的判据刻意是**券的状态动词**（失效/过期/待领取/去领），
 * 「到账」「已收到」不在词表里，就是为了放行真收入。
 */
const REAL_INCOME = [
  '你收到一个5.00元红包',
  '微信红包 收款5.00元',
  '好友给你发了一个10元红包，已存入零钱',
] as const

/**
 * 「短句里的光杆数字」也得进 AI：线上真账全部落在这条信号上。
 *
 * 这组是 `bare_amount`（tier2）**当前唯一的真实用途**——它们没有货币单位、没有
 * 标准动词，靠的就是「短 + 有数字」被捞进来。少一条就是一次静默漏账，所以任何
 * 收紧 `bare_amount` 的改动都必须让这组继续通过（见 §classifyNotification 的
 * 「按 channel 收紧」讨论：104 条靠它进来的记录里，15 条 success 全是这类手动短句，
 * 而 89 条通知侧噪声一条真账都没有）。
 */
const BARE_AMOUNT_REAL = [
  '工资50',
  '吃饭花了456',
  '电费99.5',
  '午饭22',
  '饭卡充值500',
  '妹11.07 [转账] 已被接收',
] as const

describe('extractMoneyAmounts', () => {
  it('识别符号、汉字单位、单位在数字前三种写法', () => {
    expect([...extractMoneyAmounts('已支付¥32.50')]).toEqual([32.5])
    expect([...extractMoneyAmounts('消费3.90元')]).toEqual([3.9])
    expect([...extractMoneyAmounts('支出人民币4.20元')]).toEqual([4.2])
    expect([...extractMoneyAmounts('入账工资，人民币14322.83')]).toEqual([14322.83])
  })

  it('剥掉千分位，不把 1,173.20 抽成 173.2', () => {
    expect([...extractMoneyAmounts('消费1,173.20人民币')]).toEqual([1173.2])
    expect([...extractMoneyAmounts('收入(工资)2,720元，余额25,210.99元')]).toEqual([2720, 25210.99])
  })

  it('千分位后紧跟汉字单位时也要剥（不能用 \\b 收尾）', () => {
    // 「元」在 JS/Python 里都是 \w，\d{3}\b 在这里不成立——这是踩过的坑
    expect([...extractMoneyAmounts('支出1,000元')]).toEqual([1000])
  })

  // kiro 审查发现的三个缺陷，逐个锁住
  it('畸形数字抽不出值，而不是抽出错值', () => {
    expect([...extractMoneyAmounts('消费2.555元')]).toEqual([])     // 曾被抽成 555
    expect([...extractMoneyAmounts('支出1,23元')]).toEqual([])      // 曾被抽成 23
    expect([...extractMoneyAmounts('金额12,34,567元')]).toEqual([]) // 曾被抽成 34567
    expect([...extractMoneyAmounts('3块5')]).toEqual([])           // 曾被抽成 3
  })

  it('没有货币单位的数字一律不抽', () => {
    expect([...extractMoneyAmounts('尾号1678的招行信用卡')]).toEqual([])
    expect([...extractMoneyAmounts('花3得29')]).toEqual([])
  })
})

describe('classifyNotification · 真交易不得被误杀', () => {
  it.each(REAL_TXNS)('「%s…」应判为调 AI', (text) => {
    const c = classifyNotification(text)
    expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(true)
  })

  it.each(REAL_TXNS)('「%s…」的金额必须能佐证', (text, cents) => {
    expect(hasCorroboration(text, cents)).toBe(true)
  })

  it('真交易但金额无货币单位佐证（小铁台球）不得被丢弃，只能标 review', () => {
    const text = '订单已消费 您的订单【小铁台球】39.9两小时中八（周末、节假日通用）已成功消费。'
    expect(hasCorroboration(text, 3990)).toBe(false)          // 确实无佐证
    expect(shouldCallAi(classifyNotification(text))).toBe(true) // 但必须调 AI
    const r = verifyParsed(text, [{ type: 'expense', amount: 3990, description: '小铁台球消费' }], true)
    expect(r.verdict).toBe('review')
  })

  it('「支付成功 ￥30.26 回首页」有正向信号，弱噪声不得压过它（曾被 首页 误杀）', () => {
    const c = classifyNotification('支付成功 ￥30.26 支付成功 回首页 好想来零食乐园 完成')
    expect(c.tier).toBe(1)
    expect(c.reasons).toContain('money+verb')
  })

  it('「0元」不得命中 3.90元 / 4.20元 / 16.90元（曾误杀 213 条银行通知）', () => {
    for (const t of [
      '交易提醒 你在友宝有一笔3.90元的免密/自动扣款支付，',
      '动账提醒 您尾号2256的储蓄账户8月1日9时58分支出人民币4.20元。',
      '交易提醒 你有一笔16.90元的支出，领最高2.7元满5元提现。',
    ]) {
      expect(classifyNotification(t).tier, t).toBe(1)
    }
  })

  it('动词紧邻数字仍要判为 tier1（kiro 审查发现：右边界曾把动词判漏）', () => {
    // 「动词 + 数字」是银行通知最常见的写法。语义动词不能套数字边界，
    // 否则 消费32.50 / 扣款59 / 支付成功30.26 全被判成 money_only。
    for (const t of [
      '消费16.90元',
      '支付成功30.26元',
      '扣款59元',
      '招行信用卡消费32.50人民币',
      '您尾号1678的招行信用卡消费1,173.20人民币',
    ]) {
      expect(classifyNotification(t).tier, t).toBe(1)
    }
  })

  it('订单状态推送即便带正向信号也丢弃（已记过账，重复入账才是真问题）', () => {
    // 「已签收」属强噪声：这条是订单状态更新，不是新交易。线上曾被记成新账。
    expect(classifyNotification('支付成功 ¥80 凯贝尔蛋白锌 已签收，待确认收货 礼盒沃隆').tier).toBe(0)
  })
})

/* ══════════════════════════════════════════════════════════
   手打短句：没有货币单位 + 没有交易动词，但确实是真账。

   这些正是 quick-parser 注释里写明「低置信 → 交给 AI」的例子；
   而分流曾经把它们判成 tier 4（无信号）⇒ **模型从来没被问过**，
   用户看到的是「AI 没听出账目」——他说的是「房租5000」。
   漏挡真账比误挡严重得多（用户会以为记上了）。
   ══════════════════════════════════════════════════════════ */
describe('classifyNotification · 手打短句（无货币单位）不得在预筛被丢', () => {
  it.each(BARE_AMOUNT_REAL)('「%s」应继续调 AI（bare_amount 是它唯一的入口）', (text) => {
    const c = classifyNotification(text)
    expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(true)
  })
  it.each(['肯德基45', '小米商城299', '房租5000', '报销500', '房款600000'])(
    '「%s」应放行给 AI（tier2，出站还要过佐证）',
    (text) => {
      const c = classifyNotification(text)
      expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(true)
      expect(c.tier).toBe(2)
      expect(c.reasons).toContain('bare_amount')
      expect(requiresCorroboration(c)).toBe(true)
    },
  )

  it('报销/退货是真金白银的动词，不再是「无信号」', () => {
    expect(classifyNotification('报销').tier).toBe(3)
    expect(classifyNotification('退货到账').tier).not.toBe(4)
  })

  it('长文本不因里面有数字而被放行（预筛的收益必须保住）', () => {
    const long = '亲爱的用户您好，感谢您一直以来对我们的支持与厚爱，为了回馈广大用户，我们特别推出了一系列精彩活动，详情请见活动页面，祝您生活愉快，万事如意'
    expect(long.length).toBeGreaterThan(30)
    expect(classifyNotification(long).tier).toBe(4)
    expect(classifyNotification(`${long}（活动编号 20260101）`).tier).toBe(4)
  })

  it('短广告仍先被营销词挡下（光杆数字排在弱噪声之后）', () => {
    for (const t of ['双11 5折', '满减 300', '神券 200']) {
      expect(shouldCallAi(classifyNotification(t)), t).toBe(false)
    }
  })

  it('1 位数字不算金额信号（「买了1个」）', () => {
    expect(classifyNotification('买了1个').tier).toBe(4)
  })
})

describe('classifyNotification · 噪声应被拦下', () => {
  it.each(NOISE)('「%s…」应判为不调 AI', (text) => {
    const c = classifyNotification(text)
    expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(false)
  })

  it('营销文案即使带金额也判丢弃（0元诱导）', () => {
    expect(classifyNotification('😍1号会员日来啦 🛒12包抽纸0元领千份放量！ 🔥实付159元').tier).toBe(0)
  })

  it('券面额不是到账金额：平铺写法的「10元红包」也要拦（老规则只认 [QQ红包]/红包：）', () => {
    const c = classifyNotification('支付宝卡包 你有淘宝闪购10元红包今晚失效')
    expect(shouldCallAi(c), `reasons=${c.reasons}`).toBe(false)
    expect(c.reasons).toContain('coupon_facevalue')
  })

  it('招募广告承诺的奖励不入账（真事故：¥200 虚增收入）', () => {
    const c = classifyNotification('在线寻找手游玩家 参加访谈任务，获得 200 元京东卡！')
    expect(shouldCallAi(c), `reasons=${c.reasons}`).toBe(false)
  })

  it('网速/下载进度读数靠 traffic_meter 挡下，而不是裸掉成「无信号」（可归因）', () => {
    // 归因要能落到 rule_id：客户端与服务端共用同一份规则才能对账
    for (const t of ['konghonglee 916B/s↑ 430B/s↓', '正在下载拼多多 迅雷正在加速 100%']) {
      const c = classifyNotification(t)
      expect(shouldCallAi(c), t).toBe(false)
      expect(c.reasons, t).toContain('traffic_meter')
    }
  })

  it('订单状态推进同样要落到 order_state（不是 bare_amount）', () => {
    for (const t of ['订单将在12:15自动取消 等待支付', '预计12:33送达 骑士正在配送']) {
      const c = classifyNotification(t)
      expect(shouldCallAi(c), t).toBe(false)
      expect(c.reasons, t).toContain('order_state')
    }
  })
})

describe('classifyNotification · 真实收入不得被新规则误杀', () => {
  it.each(REAL_INCOME)('「%s」应继续调 AI', (text) => {
    const c = classifyNotification(text)
    expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(true)
  })

  it('银行卡入账类通知不受影响（1444 条里占大头）', () => {
    for (const t of [
      '招商银行 信用卡通知：您尾号1678的招行信用卡消费11.74人民币。',
      '招商银行 招商银行支付鼓励金已于08月08日17:25成功入账至您的招商银行储蓄卡2415，人民币0.80元。',
      '微信支付 退款到账通知',
    ]) {
      expect(shouldCallAi(classifyNotification(t)), t).toBe(true)
    }
  })

  it('traffic_meter 不得误杀真收入：带货币金额+动词的账照旧调 AI', () => {
    // 这条新规则带 `↑↓` 与 `正在下载`，最担心的就是压过真账。
    // 它挂在弱噪声位（tier1 先返回），所以这些必须原样放行：
    for (const t of [
      '微信支付 已支付¥32.50',
      '扫码支付 便利店 消费 8.50元',
      '退款到账 100 元',
      '动账提醒 您尾号2256的储蓄账户8月1日9时58分支出人民币4.20元。',
      '交易提醒 你有一笔13.00元的支出，',
    ]) {
      const c = classifyNotification(t)
      expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons} text=${t}`).toBe(true)
    }
  })

  it('金额佐证层对 tier1 已饱和：不开启也能保证 0 条编造（734 条生产样本）', () => {
    // 这条测的是「不要为了防御而加新规则」：tier1 的金额 100% 能在原文里找到，
    // 佐证加在那里不产生任何收益，只是白跑一次。
    const text = '支付成功 12元 最近消息 1条新消息 支付宝卡包 你有淘宝闪购满28减12元红包今晚失效 5分钟前 淘宝闪购 付款成功￥0.90'
    expect(hasCorroboration(text, 1200)).toBe(true)
    expect(hasCorroboration(text, 90)).toBe(true)
  })
})

describe('金额硬规则', () => {
  it('卡号尾号不能当金额（真实事故：尾号1678 → ¥1,678.00）', () => {
    const text = '招商银行 信用卡通知：您尾号1678的招行信用卡消费1.00人民币。'
    expect(amountIsNonAmountDigit(text, 167800)).toBe(true)
    expect(amountIsNonAmountDigit(text, 100)).toBe(false)
  })

  it('机票票号不能当金额（prompt 里举的就是这个例子，机械层也要有兜底）', () => {
    // 现在「金额 >1000万元 就静默丢」那道闸门已经拆了（它会误杀购车/房款），
    // 挡数字串的职责落在这里，所以词表要把票号补上。
    const text = '南方航空 您的机票已于2026-08-11支付成功，乘机人李某某，票号7842305955315，北京大兴机场→重庆江北机场。'
    expect(amountIsNonAmountDigit(text, 784230595531500)).toBe(true)
    expect(amountIsNonAmountDigit(text, 2026)).toBe(false)
  })

  it('尾号恰好等于消费额时不得丢真交易（kiro 审查发现的丢数据路径）', () => {
    // 尾号 4 位、消费额几百上千，撞上不罕见。金额本身带货币单位 = 它就是金额。
    const text = '招商银行 信用卡通知：您尾号1678的招行信用卡消费1678.00元。'
    expect(hasCorroboration(text, 167800)).toBe(true)
    expect(amountIsNonAmountDigit(text, 167800)).toBe(true)   // 确实撞上了尾号
    const r = verifyParsed(text, [{ type: 'expense', amount: 167800, description: '招行信用卡消费' }], false)
    expect(r.verdict).toBe('pass')                             // 但不能丢
  })

  it('尾号当金额且无佐证时仍要拦（原始事故场景不能被上面的修复放过）', () => {
    const text = '招商银行 信用卡通知：您尾号1678的招行信用卡消费1.00人民币。'
    const r = verifyParsed(text, [{ type: 'expense', amount: 167800, description: '招行信用卡消费' }], false)
    expect(r.verdict).toBe('drop')
    expect(r.reason).toBe('card_digit_as_amount')
  })

  it('群名/QQ 号后面的数字不能当金额（真实事故：209[嗨] → ¥209.00）', () => {
    expect(amountIsNonAmountDigit('209[嗨] [QQ红包]国庆快乐', 20900)).toBe(true)
  })

  it('「共N笔」的总额不得按笔数平摊（真实事故：220元 → 110+110）', () => {
    const text = '【记账日报】昨天共有2笔支出 昨日支出220.00元，共2笔'
    const items = [
      { type: 'expense', amount: 11000, description: 'a' },
      { type: 'expense', amount: 11000, description: 'b' },
    ]
    expect(isFabricatedSplit(text, items)).toBe(true)
  })

  it('两笔金额不等时不算平摊', () => {
    const text = '【记账日报】昨天共有2笔支出 昨日支出220.00元，共2笔'
    const items = [
      { type: 'expense', amount: 9000, description: 'a' },
      { type: 'expense', amount: 13000, description: 'b' },
    ]
    expect(isFabricatedSplit(text, items)).toBe(false)
  })
})

describe('verifyParsed（方案 B 的边界）', () => {
  const item = (amount: number, desc = '') => ({ type: 'expense', amount, description: desc })

  it('丢：芭芭农场一分钱（线上已落地 10 次，¥0.01 垃圾账）', () => {
    const r = verifyParsed('【支付宝芭芭农场】一分钱领一箱水果', [item(1)], false)
    expect(r.verdict).toBe('drop')
  })

  it('丢：QQ 红包群名数字', () => {
    const r = verifyParsed('209[嗨] [QQ红包]国庆快乐', [item(20900, '国庆红包')], false)
    expect(r.verdict).toBe('drop')
  })

  it('丢：记账日报（强噪声先命中；平摊检测是第二道保险）', () => {
    const text = '【记账日报】昨天共有2笔支出 昨日支出220.00元，共2笔'
    const r = verifyParsed(text, [item(11000, 'a'), item(11000, 'b')], false)
    expect(r.verdict).toBe('drop')
    expect(['self_report', 'fabricated_split']).toContain(r.reason)
  })

  it('丢：非日报文本里的总额平摊（验证 fabricated_split 这条路径真的可达）', () => {
    const text = '招商银行 9月1日至9月30日共2笔 快捷支付 合计220.00元'
    const r = verifyParsed(text, [item(11000, 'a'), item(11000, 'b')], false)
    expect(r.verdict).toBe('drop')
    expect(r.reason).toBe('fabricated_split')
  })

  it('丢：双11 花3得29（线上真实误判）', () => {
    const r = verifyParsed('🧧双11省钱卡已开抢！ 双11省钱卡花3得29，一笔回本🔥加赠99积分0元兑', [item(300)], true)
    expect(r.verdict).toBe('drop')
  })

  it('放行：小铁台球 39.9 —— 无货币单位但是真消费（线上已落地）', () => {
    const text = '订单已消费 您的订单【小铁台球】39.9两小时中八（周末、节假日通用）已成功消费。'
    const r = verifyParsed(text, [item(3990, '小铁台球消费')], true)
    expect(r.verdict).not.toBe('drop')
  })

  it('放行：正常银行通知', () => {
    const text = '招商银行 信用卡通知：您尾号1678的招行信用卡消费32.50人民币。'
    const r = verifyParsed(text, [item(3250, '信用卡消费')], false)
    expect(r.verdict).toBe('pass')
  })

  it('review：档 2/3（无佐证但像交易）不丢，只标待审', () => {
    // 整段无信号（tier 4）→ 整段丢：这句既无金额也没动词，模型确实抽不出东西
    expect(verifyParsed('昨天在星巴克请朋友喝了两杯拿铁，用信用卡付的', [item(3990)], true).verdict).toBe('drop')
    // 有交易动词、无货币单位 → 档 3 → 调 AI + 强制佐证 → review
    const text = '订单已消费 您的订单【小铁台球】39.9两小时中八已成功消费'
    expect(verifyParsed(text, [item(3990)], true).verdict).toBe('review')

    /* 注：本用例以前用「小铁台球 39.9」（截断的短句）当 tier 4 的例子。
       现在短句里的光杆数字算 tier 2（reason=`bare_amount`）——它很可能就是一条被
       截断的真实通知（同一个台球的完整通知就在上面那条用例里），整段丢=漏记一笔真账
       （「只挡噪声、不漏真账」）。所以 tier 4 的例子换成真正无信号的句子。 */
    expect(verifyParsed('小铁台球 39.9', [item(3990)], true).verdict).toBe('review')
  })

  it('逐条判定：混合结果时按条给结论，不整段一刀切', () => {
    const text = '【支付宝芭芭农场】一分钱领一箱水果'
    const r = verifyParsed(text, [item(1), item(200)], false)
    expect(r.perItem[0]!.verdict).toBe('drop')
    expect(r.perItem[1]!.verdict).toBe('drop')
  })
})

describe('档位与后续动作的对应', () => {
  it('requiresCorroboration 只对档 2/3 成立', () => {
    expect(requiresCorroboration({ tier: 1, reasons: [] })).toBe(false)
    expect(requiresCorroboration({ tier: 2, reasons: [] })).toBe(true)
    expect(requiresCorroboration({ tier: 3, reasons: [] })).toBe(true)
  })
})
