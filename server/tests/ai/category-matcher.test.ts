/**
 * 分类匹配器单元测试（**Step 5：全部改调 resolveCategory**）
 *
 * 这 7 条用例是归类层的**最小回归集**，Step 1 起它们一条都没改过；Step 5 删掉
 * deprecated 的 `matchCategory` shim 后，改调 `resolveCategory` **并保留原有断言**
 * （精确 / 模糊 / 兜底「其他」/ 空输入 / 无分类时 null / 归不出来时留空）。
 *
 * 完整的新契约（reason 枚举、L4/L5 规则、噪声闸、极性矩阵）由
 * tests/ai/category-resolver.test.ts 覆盖；本文件只锁「老行为的落点没变」。
 */
import { describe, it, expect } from 'vitest'
import { resolveCategory, type CategoryInfo } from '../../src/ai/category-matcher.js'

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
  const cats = categories as readonly CategoryInfo[]
  const of = (requested: string, type: 'expense' | 'income', set = cats) =>
    resolveCategory({ requested, type, categories: set, evidenceText: 'x' })

  it('should match exact category name', () => {
    const result = of('餐饮', 'expense')
    expect(result.category_id).toBe(1)
    expect(result.category_name).toBe('餐饮')
  })

  it('should match "交通" for transportation', () => {
    expect(of('交通', 'expense').category_id).toBe(2)
  })

  it('should match income category correctly', () => {
    expect(of('工资', 'income').category_id).toBe(20)
  })

  it('should fallback to "其他" when no match found', () => {
    const result = of('不存在的分类ABC', 'expense')
    expect(result.category_id).toBe(12) // 其他 in expense
    expect(result.reason).toBe('other_fallback')
  })

  it('should fallback to "其他" for income when no match', () => {
    expect(of('未知收入', 'income').category_id).toBe(99)
  })

  it('should handle empty input gracefully', () => {
    // 空分类名不抛错；「其他」桶是用户自己建的桶，仍是合法落点（Step 2 起不再兜第一个分类）
    const result = of('', 'expense')
    expect(result.category_id).toBe(12)
    expect(result.category_name).toBe('其他')
  })

  it('用户该类型下一个分类都没有、或归不出来时返回 null，不返回不存在的 id 0', () => {
    // 0 是「不存在的 id」：客户端拿它去 POST /transactions 会被归属校验 400，
    // 而 null 是契约内合法值（转账路径本来就是 null）
    expect(of('餐饮', 'expense', [{ id: 20, name: '工资', type: 'income' }]).category_id).toBeNull()
    // Step 2：该类型有分类（哪怕只有一个）、但没有「其他」且归不出来 → 留空。
    // 旧实现会一路掉到 `categories[0]`，凭空把「日用」安到一笔账上（种子表第一项
    // 是「餐饮」，所以真实用户看到的是「归不了类 → 记成餐饮」，且看不出异常）。
    const orphan = of('不存在的分类ABC', 'expense', [{ id: 7, name: '日用', type: 'expense' }])
    expect(orphan.category_id).toBeNull()
    expect(orphan.category_name).toBe('')
    expect(orphan.reason).toBe('undetermined')
  })
})