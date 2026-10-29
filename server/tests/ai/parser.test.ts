/**
 * AI 解析器单元测试
 * 覆盖: extractJsonArray、validateParsedItems
 */
import { describe, it, expect } from 'vitest'
import { extractJsonArray, validateParsedItems, ParseError } from '../../src/ai/parser.js'
import { quickParse } from '../../src/ai/quick-parser.js'

describe('AI Parser', () => {
  const today = '2026-07-30'

  describe('extractJsonArray', () => {
    // 线上实测：模型偶尔把整个数组再包一层 JSON 字符串。
    // 没有兜底时，一笔完全正常的交易会被判成「无法从 AI 响应中提取有效 JSON」。
    it('should unwrap double-encoded JSON string', () => {
      const inner = '[{"type":"income","amount":14322.83,"category":"工资","description":"招商银行工资入账","date":"2026-10-08","account":"银行卡"}]'
      const result = extractJsonArray(JSON.stringify(inner))
      expect(result).toHaveLength(1)
      expect(result[0].amount).toBe(14322.83)
    })

    // 另一类线上失败：prompt 的示例写的是单个对象，模型就返回单个对象。
    // 配合 prompts.ts 里「最外层必须是数组」的修正，两边一起治。
    it('should wrap a bare object into an array', () => {
      const obj = '{"type":"expense","amount":39.90,"category":"娱乐","description":"小铁台球两小时消费","date":"2026-10-10","account":""}'
      const result = extractJsonArray(obj)
      expect(result).toHaveLength(1)
      expect(result[0].amount).toBe(39.9)
    })

    it('should parse plain JSON array', () => {
      const input = '[{"type":"expense","amount":32,"category":"餐饮","description":"午饭","date":"2026-07-30","account":"微信"}]'
      const result = extractJsonArray(input)
      expect(result).toHaveLength(1)
      expect(result[0].amount).toBe(32)
    })

    it('should parse JSON in markdown code block', () => {
      const input = '```json\n[{"type":"expense","amount":15,"category":"交通","description":"地铁","date":"2026-07-30","account":""}]\n```'
      const result = extractJsonArray(input)
      expect(result).toHaveLength(1)
      expect(result[0].category).toBe('交通')
    })

    it('should parse JSON with surrounding text', () => {
      const input = '好的，解析结果如下：\n[{"type":"expense","amount":28,"category":"餐饮","description":"咖啡","date":"2026-07-30","account":"支付宝"}]\n希望能帮到你！'
      const result = extractJsonArray(input)
      expect(result).toHaveLength(1)
      expect(result[0].description).toBe('咖啡')
    })

    it('should throw ParseError on invalid content', () => {
      expect(() => extractJsonArray('I cannot parse this input.')).toThrow(ParseError)
    })

    it('should throw ParseError on empty object', () => {
      expect(() => extractJsonArray('{"key": "value"}')).toThrow(ParseError)
    })
  })

  describe('validateParsedItems', () => {
    it('should accept valid items', () => {
      const items = [
        { type: 'expense' as const, amount: 32, category: '餐饮', description: '午饭', date: '2026-07-30', account: '微信' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(1)
      expect(result[0].amount).toBe(32)
    })

    it('畸形 JSON 元素和非字符串字段不能逃过类型校验', () => {
      const valid = { type: 'expense', amount: 32, description: '午饭' }
      const malformed: unknown[] = [null, true, 3, 'x', [],
        { ...valid, amount: true }, { ...valid, amount: [] },
        ...['category', 'description', 'account', 'target_account', 'date'].map((key) => ({ ...valid, [key]: {} })),
      ]
      expect(validateParsedItems([...malformed, valid], today)).toEqual([
        { ...valid, category: '', account: '', date: today, target_account: undefined },
      ])
    })

    it.each(['¥32.00', '32元', '1,000.00元'])('完整金额字符串 %s 不截断数值', (amount) => {
      const result = validateParsedItems([{ type: 'expense', amount }], today)
      expect(result[0].amount).toBe(amount.includes(',') ? 1000 : 32)
    })

    it.each(['2万元', '32元未支付', 'abc32', '1,23元'])('不完整金额字符串 %s 不取局部数字', (amount) => {
      expect(validateParsedItems([{ type: 'expense', amount }], today)).toEqual([])
    })

    it('should filter out items with invalid type', () => {
      const items = [
        { type: 'invalid' as any, amount: 32, category: '餐饮', description: '午饭', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(0)
    })

    it('should filter out items with zero/negative amount', () => {
      const items = [
        { type: 'expense' as const, amount: 0, category: '餐饮', description: '免费', date: '2026-07-30', account: '' },
        { type: 'expense' as const, amount: -10, category: '餐饮', description: '负数', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(0)
    })

    it('千万级/亿级真账不得被静默丢掉（购车、房款）', () => {
      // 以前 >1000万元 直接 continue：整条消失且无提示。
      // 每一条解析结果都是确认卡片，真账该让用户自己判断。
      const items = [
        { type: 'expense' as const, amount: 2800000, category: '其他', description: '购车款', date: '2026-07-30', account: '' },
        { type: 'expense' as const, amount: 99999999, category: '其他', description: '房款', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.amount)).toEqual([2800000, 99999999])
    })

    it('只丢「不可表示」的金额（转分后超过安全整数）', () => {
      const items = [
        { type: 'expense' as const, amount: 1e14, category: '其他', description: '不可表示', date: '2026-07-30', account: '' },
      ]
      expect(validateParsedItems(items, today)).toHaveLength(0)
    })

    it('should use today when date is invalid', () => {
      const items = [
        { type: 'expense' as const, amount: 20, category: '餐饮', description: '午饭', date: 'invalid', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(1)
      expect(result[0].date).toBe(today)
    })

    it('should truncate long descriptions', () => {
      const items = [
        { type: 'expense' as const, amount: 100, category: '购物', description: '这是一个特别长的描述超过二十个字限制的文本内容', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result[0].description.length).toBeLessThanOrEqual(20)
    })

    it('should filter out noise descriptions', () => {
      const items = [
        { type: 'expense' as const, amount: 50, category: '购物', description: '去支付', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(0)
    })

    it('should handle transfer type without category', () => {
      const items = [
        { type: 'transfer' as const, amount: 500, category: '', description: '转账', date: '2026-07-30', account: '微信', target_account: '支付宝' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('transfer')
      expect(result[0].target_account).toBe('支付宝')
    })
  })
})

describe('quickParse 完整消费输入', () => {
  const context = { today: '2026-10-28', expenseCategories: ['餐饮'], incomeCategories: ['工资'], accounts: ['微信', '现金'] }

  it.each(['午饭32元未支付', '午饭32元已取消', '午饭3块5', '午饭32美元'])('%s 不走快捷解析', (input) => {
    expect(quickParse(input, context)).toBeNull()
  })

  it.each([['工资2万元', 20000], ['工资1.5万', 15000], ['工资2千元', 2000], ['工资2亿元', 200000000]] as const)('%s 完整解析金额单位', (input, amount) => {
    expect(quickParse(input, context)?.[0]).toMatchObject({ amount, type: 'income' })
  })

  it.each(['午饭32', '午饭32元', '午饭32微信', '32元午饭', '午饭微信32'])('%s 保持快捷解析', (input) => {
    expect(quickParse(input, context)?.[0]).toMatchObject({ amount: 32, type: 'expense', category: '餐饮' })
  })
})
