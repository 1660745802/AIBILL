/**
 * 这条测试在锁什么
 * ----------------
 * `NOISE_TERMS` 这张**结构化噪声词表**的两条铁律（后续 matcher 噪声闸 L1 的前置）：
 *
 * 1. **裸词永不判噪声**：每条词条都必须带 context，且命中条件是
 *    「term 出现在原文」**且**「context 同时出现在原文」。
 *    只锁 term 的写法会让「红包」「优惠券」这类**真实收入**被当广告丢掉。
 * 2. **语境正则必须无状态**：带 `g`/`y` 的正则在 `test()` 后 lastIndex 不回零，
 *    同一条词条对同一段原文会「第一次命中、第二次不命中」——
 *    这是跨端判据分叉的头号成因（见 verify.ts 里 INBOUND_SIGNAL_SOURCES 的注释）。
 *
 * 语料用设计 §0.7 实测过的 6 条**真实红包收入**样本 + 4 条券面额广告样本：
 * 这是「同一个词、相反期望、靠语境区分」的最小证明集。分类/归类本身由
 * category-matcher 测试负责，本文件只管「这张表判不判噪声」。
 *
 * ⚠️ 本表**不参与**现有分流（verify 的 STRONG/WEAK 正则一行未改），
 * 所以这里没有、也不该有对 classifyNotification 的断言。
 */
import { describe, it, expect } from 'vitest'
import { NOISE_TERMS } from '../../src/ai/noise-terms.js'

/** 命中该词条的全部条件（term + context 同现）时，返回它 */
function firedTerms(text: string): string[] {
  return NOISE_TERMS
    .filter((n) => text.includes(n.term) && n.context.test(text))
    .map((n) => `${n.term}→${n.reason}`)
}

/** 设计 §0.7：真实红包收入样本（必须全部**不**判噪声，否则是把真账当广告丢） */
const REAL_INCOME = [
  '你收到一个5.00元红包',
  '微信红包 收款5.00元',
  '好友给你发了一个10元红包，已存入零钱',
  '您的好友给您发来红包 66.00元',
  '你的红包 100.00元 已存入零钱',
  '【微信】你领取了好友的红包 8.88元',
]

/** 设计 §0.7：券面额广告样本（必须全部判噪声） */
const COUPON_ADS = [
  '您有闪购外卖红包未查收',
  '您有一个红包未领取 速来淘宝闪购！',
  '支付宝卡包 你有淘宝闪购10元红包今晚失效',
  '恭喜你获得支付宝红包 5.00元，已存入余额',
]

describe('NOISE_TERMS 结构', () => {
  it('每条词条都带必填 context（没有裸词）', () => {
    expect(NOISE_TERMS.length).toBeGreaterThan(0)
    for (const n of NOISE_TERMS) {
      expect(n.term.length).toBeGreaterThan(0)
      expect(n.context).toBeInstanceOf(RegExp)
      expect(n.context.source.length).toBeGreaterThan(0)
      expect(n.reason.length).toBeGreaterThan(0)
    }
  })

  it('语境正则不带 g/y（test() 必须无状态，否则同一条词条第二次就不命中）', () => {
    for (const n of NOISE_TERMS) {
      expect(n.context.global).toBe(false)
      expect(n.context.sticky).toBe(false)
    }
  })

  it('同一个词对同一段原文重复判定结果一致（lastIndex 污染护栏）', () => {
    const text = '支付宝卡包 你有淘宝闪购10元红包今晚失效'
    expect(firedTerms(text)).toEqual(firedTerms(text))
  })

  it('词条不重复（同一个 term+reason 只留一条，语境归并进 context）', () => {
    const keys = NOISE_TERMS.map((n) => `${n.term}|${n.reason}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('NOISE_TERMS · 词与语境必须同现', () => {
  it.each(REAL_INCOME)('真实红包收入不判噪声：%s', (text) => {
    expect(firedTerms(text)).toEqual([])
  })

  it.each(COUPON_ADS)('券面额广告判噪声：%s', (text) => {
    expect(firedTerms(text).length).toBeGreaterThan(0)
  })

  it('光有词、没有语境 = 不判噪声（用户自建同名分类不会被误杀）', () => {
    expect(firedTerms('优惠券50')).toEqual([])
    expect(firedTerms('红包100')).toEqual([])
  })

  it('语境在、词不在也不判噪声（避免一个万能语境把所有文本打成广告）', () => {
    expect(firedTerms('您的包裹已签收，运费12元')).toEqual([])
    expect(firedTerms('账单明细 商品 39.00 优惠 10.00 实付 29.00')).toEqual([])
  })
})