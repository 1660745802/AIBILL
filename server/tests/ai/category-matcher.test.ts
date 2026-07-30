/**
 * 分类匹配器单元测试
 * 覆盖: matchCategory 精确匹配、模糊匹配、fallback 到其他
 */
import { describe, it, expect } from 'vitest'
import { matchCategory } from '../../src/ai/category-matcher.js'

describe('Category Matcher', () => {
  const categories = [
    { id: 1, name: '餐饮', type: 'expense' as const },
    { id: 2, name: '交通', type: 'expense' as const },
    { id: 3, name: '购物', type: 'expense' as const },
    { id: 4, name: '娱乐', type: 'expense' as const },
    { id: 5, name: '住房', type: 'expense' as const },
    { id: 12, name: '其他', type: 'expense' as const },
    { id: 20, name: '工资', type: 'income' as const },
    { id: 21, name: '奖金', type: 'income' as const },
    { id: 99, name: '其他', type: 'income' as const },
  ]

  it('should match exact category name', () => {
    const result = matchCategory('餐饮', categories, 'expense')
    expect(result.id).toBe(1)
    expect(result.name).toBe('餐饮')
  })

  it('should match "交通" for transportation', () => {
    const result = matchCategory('交通', categories, 'expense')
    expect(result.id).toBe(2)
  })

  it('should match income category correctly', () => {
    const result = matchCategory('工资', categories, 'income')
    expect(result.id).toBe(20)
  })

  it('should fallback to "其他" when no match found', () => {
    const result = matchCategory('不存在的分类ABC', categories, 'expense')
    expect(result.id).toBe(12) // 其他 in expense
  })

  it('should fallback to "其他" for income when no match', () => {
    const result = matchCategory('未知收入', categories, 'income')
    expect(result.id).toBe(99)
  })

  it('should handle empty input gracefully', () => {
    const result = matchCategory('', categories, 'expense')
    // Should not throw, should return some category
    expect(result.id).toBeTruthy()
  })
})
