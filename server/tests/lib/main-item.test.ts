/**
 * 挑笔器（`lib/main-item.ts`）——「一次解析只回一笔」的唯一实现
 *
 * 产品决定（2026-10）：**取消批量记账**，`POST /api/ai/parse` 的 `items` 恒 ≤ 1。
 * 挑笔标准必须只有一份实现：客户端曾自研 `aiItemScore` + `maxByOrNull`（静默丢弃其余），
 * 两套标准并存就是两套口径。本文件锁住标准的优先级与**确定性**。
 */
import { describe, it, expect } from 'vitest'
import { pickMainItem } from '../../src/lib/main-item.js'

const mk = (over: Record<string, unknown> = {}) => ({
  type: 'expense',
  amount: 100,
  category_id: 1,
  account_id: 1,
  description: 'x',
  date: '2026-10-12',
  ...over,
})

describe('pickMainItem · 挑笔标准', () => {
  it('空 → null；单笔 → 原样返回且不计数', () => {
    expect(pickMainItem([], '')).toEqual({ main: null, droppedCount: 0 })
    const one = mk()
    expect(pickMainItem([one], '午饭1元')).toEqual({ main: one, droppedCount: 0 })
  })

  it('① 有货币单位佐证的优先（哪怕金额更小）', () => {
    const big = mk({ amount: 9900, description: '大额无单位' })
    const small = mk({ amount: 500, description: '小额有单位' })
    // 原文只给出「5.00元」→ small 有佐证，big 没有
    const { main, droppedCount } = pickMainItem([big, small], '买了点东西 5.00元')
    expect(main).toBe(small)
    expect(droppedCount).toBe(1)
  })

  it('② 同佐证档下，信息完整度高者优先', () => {
    const sparse = mk({ amount: 9900, category_id: null, account_id: null, description: '', date: '' })
    const full = mk({ amount: 100 })
    // 两者都无佐证（原文无金额单位）→ 完整度 4 vs 1，full 胜
    const { main } = pickMainItem([sparse, full], '无金额单位的文本')
    expect(main).toBe(full)
  })

  it('③ 同佐证同完整度 → 金额降序', () => {
    const a = mk({ amount: 100 })
    const b = mk({ amount: 8800 })
    expect(pickMainItem([a, b], '无单位').main).toBe(b)
  })

  it('④ 完全相同 → 保持原序（确定性）', () => {
    const a = mk()
    const b = mk()
    expect(pickMainItem([a, b], '无单位').main).toBe(a)
    // 同一输入必得同一笔（连续两次调用一致）
    expect(pickMainItem([a, b], '无单位').main).toBe(pickMainItem([a, b], '无单位').main)
  })

  it('转账不需要分类，不因 category_id 为 null 被扣分', () => {
    const t = mk({ type: 'transfer', amount: 500, category_id: null, description: '转账', date: '2026-10-12' })
    const e = mk({ type: 'expense', amount: 900, category_id: null, account_id: null, description: '', date: '' })
    expect(pickMainItem([e, t], '无单位').main).toBe(t)
  })
})
