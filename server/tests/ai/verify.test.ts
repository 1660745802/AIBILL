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

describe('classifyNotification · 噪声应被拦下', () => {
  it.each(NOISE)('「%s…」应判为不调 AI', (text) => {
    const c = classifyNotification(text)
    expect(shouldCallAi(c), `tier=${c.tier} reasons=${c.reasons}`).toBe(false)
  })

  it('营销文案即使带金额也判丢弃（0元诱导）', () => {
    expect(classifyNotification('😍1号会员日来啦 🛒12包抽纸0元领千份放量！ 🔥实付159元').tier).toBe(0)
  })
})

describe('金额硬规则', () => {
  it('卡号尾号不能当金额（真实事故：尾号1678 → ¥1,678.00）', () => {
    const text = '招商银行 信用卡通知：您尾号1678的招行信用卡消费1.00人民币。'
    expect(amountIsNonAmountDigit(text, 167800)).toBe(true)
    expect(amountIsNonAmountDigit(text, 100)).toBe(false)
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
    // 「小铁台球 39.9」既无货币单位也无交易动词 → 档 4 → 丢，这是对的
    expect(verifyParsed('小铁台球 39.9', [item(3990)], true).verdict).toBe('drop')
    // 有交易动词、无货币单位 → 档 3 → 调 AI + 强制佐证 → review
    const text = '订单已消费 您的订单【小铁台球】39.9两小时中八已成功消费'
    expect(verifyParsed(text, [item(3990)], true).verdict).toBe('review')
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
