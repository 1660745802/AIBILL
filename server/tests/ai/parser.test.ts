/**
 * AI 解析器单元测试
 * 覆盖: extractJsonArray、validateParsedItems
 */
import { describe, it, expect } from 'vitest'
import { extractJsonArray, validateParsedItems, ParseError } from '../../src/ai/parser.js'

describe('AI Parser', () => {
  const today = '2026-07-30'

  describe('extractJsonArray', () => {
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

    it('should filter out extremely large amounts (>10M)', () => {
      const items = [
        { type: 'expense' as const, amount: 99999999, category: '其他', description: '天文数字', date: '2026-07-30', account: '' },
      ]
      const result = validateParsedItems(items, today)
      expect(result).toHaveLength(0)
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
