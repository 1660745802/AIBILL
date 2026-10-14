/**
 * 解析装配（`lib/parse-assembly.ts`）——「候选 → 响应 item」的唯一实现
 *
 * 锁住两条入口（quick / ai）合流后**只剩一份**的判据：
 *   - 归类 → category_id/name/icon；账户匹配（精确优先，双向包含兜底）
 *   - §6 机械字段：extras / confidence / needs_review / confidence_reasons
 *   - 噪声审计三键「只在噪声闸真的参与判定时」才出现
 *   - item 与 resolution 同源产出 → **下标对齐是结构保证**（不是平行数组的约定）
 *
 * 纯函数、不碰 DB/HTTP；出站校验（verifyParsed）夹在 resolveItems 与 finalizeItems 之间，
 * 是 ai 路径的策略，不在本模块。
 */
import { describe, it, expect } from 'vitest'
import { resolveItems, finalizeItems, type AssemblyContext, type CategoryRow, type AccountRow } from '../../src/lib/parse-assembly.js'
import type { ParsedExtras } from '../../src/lib/parse-extract.js'

const categories: CategoryRow[] = [
  { id: 1, name: '餐饮', type: 'expense', icon: '🍜' },
  { id: 2, name: '红包', type: 'income', icon: '🧧' },
  { id: 3, name: '其他', type: 'expense', icon: '' },
]
const accounts: AccountRow[] = [
  { id: 10, name: '微信' },
  { id: 11, name: '现金' },
]

const noExtras: ParsedExtras = {
  merchant: null, order_no: null, card_tail: null,
  balance_after_cents: null, balance_text: null, time: null,
}

const ctx = (over: Partial<AssemblyContext> = {}): AssemblyContext => ({
  input: '午饭32元',
  categories,
  accounts,
  extras: noExtras,
  path: 'quick',
  ...over,
})

const assemble = (candidates: Parameters<typeof resolveItems>[0], over: Partial<AssemblyContext> = {}) => {
  const c = ctx(over)
  return finalizeItems(resolveItems(candidates, c), c)
}

describe('parse-assembly · 候选 → item', () => {
  it('归类精确命中 + 精确账户 + §6 字段（quick 高置信）', () => {
    const [it] = assemble([
      { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '2026-10-12', account: '微信' },
    ])
    expect(it).toMatchObject({
      type: 'expense',
      amount: 3200,
      category_id: 1,
      category_name: '餐饮',
      category_icon: '🍜',
      account_id: 10,
      account_name: '微信',
      target_account_id: null,
      confidence: 'high',
      needs_review: false,
    })
    expect(it).not.toHaveProperty('category_reason')
  })

  it('账户匹配是唯一口径：精确优先，双向包含兜底（「微信支付」→ 账户「微信」）', () => {
    const [exact, fuzzy] = assemble([
      { type: 'expense', amount: 1, category: '餐饮', description: 'a', date: '2026-10-12', account: '微信' },
      { type: 'expense', amount: 1, category: '餐饮', description: 'b', date: '2026-10-12', account: '微信支付' },
    ])
    expect(exact.account_id).toBe(10)
    expect(fuzzy.account_id).toBe(10)
  })

  it('转账：无归类结果、目标账户照配、不因缺分类判 needs_review', () => {
    const [it] = assemble([
      { type: 'transfer', amount: 100, category: '', description: '微信转支付宝', date: '2026-10-12', account: '微信', target_account: '现金' },
    ])
    expect(it).toMatchObject({
      type: 'transfer',
      category_id: null,
      category_name: '',
      category_icon: '',
      account_id: 10,
      target_account_id: 11,
      target_account_name: '现金',
      needs_review: false,
    })
    // transfer 没有噪声审计
    expect(it).not.toHaveProperty('category_reason')
  })

  it('下标对齐 + 噪声审计只挂在真正命中的那一笔', () => {
    const items = assemble(
      [
        { type: 'expense', amount: 10, category: '红包', description: '闪购红包', date: '2026-10-12' },
        { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '2026-10-12' },
      ],
      { input: '恭喜获得10元红包，今晚失效；午饭32元' },
    )
    // 第 0 笔：券面额被噪声闸判掉 → 不给分类 + 三键审计 + needs_review
    expect(items[0]).toMatchObject({
      category_id: null,
      needs_review: true,
      category_reason: 'noise_word',
      noise_term: '红包',
      noise_verdict_source: 'narrow',
    })
    // 第 1 笔：正常，绝不因为第 0 笔的噪声被错挂
    expect(items[1]).toMatchObject({ category_id: 1, needs_review: false })
    expect(items[1]).not.toHaveProperty('noise_term')
  })

  it('ai 路径：verify 判 review → needs_review=true、confidence=low', () => {
    const [it] = assemble(
      [{ type: 'expense', amount: 45, category: '餐饮', description: '肯德基', date: '2026-10-12' }],
      {
        path: 'ai',
        input: '肯德基 45', // 无货币单位佐证
        verifyPerItem: { 0: { verdict: 'review', reason: 'no_corroboration' } },
      },
    )
    expect(it.needs_review).toBe(true)
    expect(it.confidence).toBe('low')
    expect(it.confidence_reasons).toContain('verify_review')
  })
})
