/**
 * `lib/parse-extract.ts` 纯函数单测（契约 docs/API.md 附录 C §6）
 *
 * 重点锁「保守边界」：命中不了一个明确、可判定的形态就返回 null，
 * 绝不拿整句/整段当结果（本项目「宁可空着也不编数」原则）。
 */
import { describe, it, expect } from 'vitest'
import {
  extractMerchant,
  extractOrderNo,
  extractCardTail,
  extractBalance,
  extractTime,
  extractParsedExtras,
  deriveReviewMeta,
} from '../../src/lib/parse-extract.js'

describe('extractMerchant', () => {
  it('分隔符前的商户片段：支付宝-美团外卖 → 美团外卖', () => {
    expect(extractMerchant('支付宝-美团外卖 支付成功 ￥30')).toBe('美团外卖')
  })

  it('括号形态：【美团】→ 美团', () => {
    expect(extractMerchant('【美团】您的订单已支付')).toBe('美团')
  })

  it('云控 source_mapping 的友好名优先', () => {
    expect(extractMerchant('任意正文', '美团')).toBe('美团')
  })

  it('支付渠道/账户类友好名不能当商户（否则所有微信通知都错成「微信支付」）', () => {
    expect(extractMerchant('任意正文', '微信支付')).toBeNull()
    expect(extractMerchant('任意正文', '支付宝')).toBeNull()
  })

  it('没有分隔符/括号时不抽（不拿整句当商户）', () => {
    expect(extractMerchant('微信支付 支付成功 ¥30')).toBeNull()
    expect(extractMerchant('您尾号1234的储蓄卡消费50.00元')).toBeNull()
  })

  it('含数字片段不当商户（卡号/日期/金额）', () => {
    expect(extractMerchant('2026-10-12 消费50元')).toBeNull()
    expect(extractMerchant('尾号1234-消费')).toBeNull()
  })

  it('多个候选=歧义 → null', () => {
    expect(extractMerchant('甲商户-乙商户')).toBeNull()
  })
})

describe('extractOrderNo', () => {
  it('关键词后的字母数字串（含数字）', () => {
    expect(extractOrderNo('订单号 2024101212345678')).toBe('2024101212345678')
    expect(extractOrderNo('流水号：AB12345678')).toBe('AB12345678')
  })

  it('太短不抽', () => {
    expect(extractOrderNo('交易号 ABC')).toBeNull()
  })

  it('纯字母状态词不抽（必须含数字）', () => {
    expect(extractOrderNo('订单号 PENDING')).toBeNull()
  })

  it('关键词后无数字不抽（订单号误命中防护）', () => {
    expect(extractOrderNo('订单号已取消')).toBeNull()
  })

  it('超过上限（32）不截断，直接 null', () => {
    expect(extractOrderNo('订单号 12345678901234567890123456789012345')).toBeNull()
  })
})

describe('extractCardTail', () => {
  it('尾号/末四位 → 4 位数字', () => {
    expect(extractCardTail('您尾号1234的储蓄卡消费50.00元')).toBe('1234')
    expect(extractCardTail('末四位 5678')).toBe('5678')
  })

  it('5 位数字不截前 4 位（错一位就是另一张卡）', () => {
    expect(extractCardTail('尾号12345')).toBeNull()
  })

  it('无关键词不抽', () => {
    expect(extractCardTail('消费50.00元')).toBeNull()
  })
})

describe('extractBalance（词界受限）', () => {
  it('无上下文词的金额不抽：转账1000 → null', () => {
    expect(extractBalance('转账1000')).toBeNull()
  })

  it('有上下文词 + 单位：返回原始片段', () => {
    expect(extractBalance('余额100.50元')).toEqual({ cents: 10050, text: '余额100.50元' })
  })

  it('货币符号 + 千分位', () => {
    expect(extractBalance('可用余额 ¥1,234.56')).toEqual({
      cents: 123456,
      text: '可用余额 ¥1,234.56',
    })
  })

  it('小数点（无单位也认）', () => {
    expect(extractBalance('账户余额为12.5')).toEqual({ cents: 1250, text: '账户余额为12.5' })
  })

  it('无单位的 ≥3 位整数认；量词后的整数不认', () => {
    expect(extractBalance('余额1000')).toEqual({ cents: 100000, text: '余额1000' })
    expect(extractBalance('剩余100张')).toBeNull()
    expect(extractBalance('剩余100GB')).toBeNull()
  })

  it('上下文词后不是金额形态不抽', () => {
    expect(extractBalance('剩余3笔')).toBeNull()
  })
})

describe('extractTime', () => {
  it('明确时刻 → HH:mm', () => {
    expect(extractTime('10月12日 14:32 消费')).toBe('14:32')
  })

  it('不从日期/金额里的数字当时间', () => {
    expect(extractTime('2026-10-12 消费50.00元')).toBeNull()
    expect(extractTime('消费50.00元')).toBeNull()
  })

  it('上午/下午前缀按 12 小时制归一', () => {
    expect(extractTime('下午3:30')).toBe('15:30')
    expect(extractTime('上午9点05分')).toBe('09:05')
  })

  it('「H点mm分」形态', () => {
    expect(extractTime('12点30分')).toBe('12:30')
  })

  it('无分钟的「3点」无上午/下午前缀 → 不可靠，null', () => {
    expect(extractTime('3点')).toBeNull()
  })
})

describe('extractParsedExtras', () => {
  it('input 抽不到时退回 fallback（title/body）', () => {
    const e = extractParsedExtras('肯德基消费45.00元', { fallbackText: '【美团】' })
    expect(e.merchant).toBe('美团')
  })

  it('balance_text 与 balance_after_cents 同来同往', () => {
    const hit = extractParsedExtras('消费50元 余额100元')
    expect(hit.balance_after_cents).toBe(10000)
    expect(hit.balance_text).toBe('余额100元')

    const miss = extractParsedExtras('消费50元')
    expect(miss.balance_after_cents).toBeNull()
    expect(miss.balance_text).toBeNull()
  })
})

describe('deriveReviewMeta', () => {
  it('high = quick + 分类精确命中 + 金额带单位', () => {
    const m = deriveReviewMeta({
      path: 'quick',
      categoryExact: true,
      amountCents: 3200,
      input: '午饭32元',
    })
    expect(m.confidence).toBe('high')
    expect(m.needs_review).toBe(false)
    expect(m.confidence_reasons).toEqual(['quick', 'category_exact', 'amount_unit'])
  })

  it('quick 但金额无单位 → 不 high；needs_review 仍为 false', () => {
    const m = deriveReviewMeta({
      path: 'quick',
      categoryExact: true,
      amountCents: 3200,
      input: '午饭32',
    })
    expect(m.confidence).toBe('low')
    expect(m.needs_review).toBe(false)
    expect(m.confidence_reasons).toContain('amount_bare')
  })

  it('medium = ai + 分类精确命中 + 佐证通过', () => {
    const m = deriveReviewMeta({
      path: 'ai',
      categoryExact: true,
      amountCents: 4500,
      input: '肯德基消费45.00元',
      classifyReasons: ['money+verb'],
      verifyVerdict: 'pass',
    })
    expect(m.confidence).toBe('medium')
    expect(m.needs_review).toBe(false)
    expect(m.confidence_reasons).toEqual(['ai', 'category_exact', 'amount_unit'])
  })

  it('needs_review：分类未精确命中', () => {
    const m = deriveReviewMeta({
      path: 'ai',
      categoryExact: false,
      amountCents: 4500,
      input: '肯德基消费45.00元',
      classifyReasons: ['money+verb'],
      verifyVerdict: 'pass',
    })
    expect(m.needs_review).toBe(true)
    expect(m.confidence).toBe('low')
    expect(m.confidence_reasons).toContain('category_fuzzy')
  })

  it('needs_review：金额来自裸数字信号', () => {
    const m = deriveReviewMeta({
      path: 'ai',
      categoryExact: true,
      amountCents: 4500,
      input: '肯德基45',
      classifyReasons: ['bare_amount'],
      verifyVerdict: 'review',
    })
    expect(m.needs_review).toBe(true)
    expect(m.confidence).toBe('low')
    expect(m.confidence_reasons).toEqual([
      'ai', 'category_exact', 'amount_bare', 'verify_review',
    ])
  })

  it('needs_review：verifyParsed 判 review', () => {
    const m = deriveReviewMeta({
      path: 'ai',
      categoryExact: true,
      amountCents: 4500,
      input: '到账一笔',
      classifyReasons: ['verb_only'],
      verifyVerdict: 'review',
    })
    expect(m.needs_review).toBe(true)
    expect(m.confidence_reasons).toContain('verify_review')
  })
})
