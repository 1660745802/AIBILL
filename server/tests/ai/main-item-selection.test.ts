/**
 * 这条测试在锁什么
 * ----------------
 * **选笔**（`lib/main-item.ts` 的 `pickMainItem`）与**归类**（`resolveCategory`）的
 * 跨模块不变量——这是 Step 2 之后唯一一个「没有被任何测试锁住的风险面」。
 *
 * 背景：`POST /api/ai/parse` 的契约是**一次解析只回一笔**（docs/API.md 附录 C §1），
 * 选错笔 = 用户确认的是另一笔 = 记错账。`pickMainItem` 的第二条标准是「信息完整度」，
 * 其中「分类」占 1 分；而 Step 2 之后「归不出来」不再拿 `categories[0]` 顶一个假分类，
 * 于是**更多 item 的 `category_id` 会是 null**，这条打分规则的输入分布变了。
 *
 * 本文件锁三件事：
 * 1. **现状（characterization）**：几组会触发多笔候选的输入——描述各不相同、
 *    有 category_id 为 null 的也有不为 null 的——断言现在选哪一笔、被裁掉几笔。
 * 2. **新的稀疏路径确实被覆盖**：至少一组用例里 `category_id: null` 的那一笔
 *    **曾经**是主笔候选（Step 2 之前它会被 `categories[0]` 补成分类从而拿到完整度分）。
 * 3. **两端口径一致**：这里复刻 `routes/ai.ts` 的组合顺序
 *    （逐笔 resolveCategory → pickMainItem），路由层只多一层 HTTP 与日志。
 *
 * ⚠️ 打分规则本身**不在本文件改动范围**（那是产品决策）；这里只锁行为、
 * 并把「删掉 categories[0] 兜底对选笔的影响」显式记录下来。
 */
import { describe, it, expect } from 'vitest'
import { resolveCategory, type CategoryInfo, type CategoryType } from '../../src/ai/category-matcher.js'
import { pickMainItem, type MainItemLike } from '../../src/lib/main-item.js'

const ex = (name: string, id: number): CategoryInfo => ({ id, name, type: 'expense' })
const inc = (name: string, id: number): CategoryInfo => ({ id, name, type: 'income' })

/** 种子用户（支出 12 项 + 收入 7 项，两边都有「其他」桶） */
const SEEDED: readonly CategoryInfo[] = [
  ex('餐饮', 1), ex('交通', 2), ex('购物', 3), ex('住房', 4), ex('娱乐', 5), ex('医疗', 6),
  ex('教育', 7), ex('通讯', 8), ex('日用', 9), ex('服饰', 10), ex('人情', 11), ex('其他', 12),
  inc('工资', 101), inc('奖金', 102), inc('理财', 103), inc('兼职', 104),
  inc('红包', 105), inc('退款', 106), inc('其他', 107),
]
/** 用户删掉了「其他」桶（Step 2 之后归不出来只能留空） */
const NO_OTHER: readonly CategoryInfo[] = [ex('餐饮', 1), ex('交通', 2), inc('工资', 101)]

interface RawItem {
  readonly type: 'expense' | 'income' | 'transfer'
  readonly amount: number
  readonly category: string
  readonly description: string
  readonly date: string
  readonly account: string
}

/** 复刻 routes/ai.ts 的组合：逐笔归类（判据只许用 input）→ 组装 item */
function resolveItems(raws: readonly RawItem[], categories: readonly CategoryInfo[], input: string) {
  return raws.map((r) => {
    // transfer 不参与归类（与 routes/ai.ts 一致：它的 category_id 恒为 null）
    const res = r.type === 'transfer'
      ? { category_id: null, category_name: '', reason: 'no_candidate' as const }
      : resolveCategory({
        requested: r.category,
        type: r.type as CategoryType,
        categories,
        evidenceText: input,
      })
    return {
      item: {
        type: r.type,
        amount: Math.round(r.amount * 100),
        category_id: res.category_id,
        category_name: res.category_name,
        reason: res.reason,
        account_id: r.account ? 1 : null,
        description: r.description,
        date: r.date,
      } satisfies MainItemLike & { category_name: string; reason: string },
    }
  })
}

describe('选笔 × 归类 · 跨模块不变量（characterization）', () => {
  it('有「其他」桶时归不出来仍有分类 id → 选笔不受影响（Step 2 对绝大多数用户无感）', () => {
    const input = '随手记了几笔'
    const built = resolveItems([
      { type: 'expense', amount: 9900, category: '不存在的科目A', description: '大额无分类', date: '', account: '' },
      { type: 'expense', amount: 1000, category: '餐饮', description: '小额有分类', date: '', account: '' },
    ], SEEDED, input)
    // 「其他」桶接住了 → 两笔都有 category_id，稀疏路径没被触发
    expect(built.map((b) => b.item.category_id)).toEqual([12, 1])
    const { main, droppedCount } = pickMainItem(built.map((b) => b.item), input)
    expect(main).toBe(built[0]!.item)
    expect(droppedCount).toBe(1)
  })

  it('★ 没有「其他」桶 + 一笔归不出来 → 该笔 category_id=null，完整度少 1 分，输给完整的那笔', () => {
    const input = '随手记了几笔'
    const built = resolveItems([
      { type: 'expense', amount: 9900, category: '不存在的科目A', description: '大额无分类', date: '', account: '' },
      { type: 'expense', amount: 1000, category: '餐饮', description: '小额有分类', date: '', account: '' },
    ], NO_OTHER, input)
    expect(built.map((b) => b.item.category_id)).toEqual([null, 1])
    expect(built[0]!.item.reason).toBe('undetermined')
    // Step 2 之前：那笔会被 categories[0]（餐饮，id=1）补上分类 → 完整度与另一笔持平
    //                → 金额降序 → 9900 那笔当选。现在它少 1 分 → 让位给 1000 那笔。
    const { main, droppedCount } = pickMainItem(built.map((b) => b.item), input)
    expect(main).toBe(built[1]!.item)
    expect(main!.category_id).toBe(1)
    expect(droppedCount).toBe(1)
  })

  it('★ 稀疏的那一笔即使金额最大也会让位（这正是 Step 2 带来的可见影响，需人工确认）', () => {
    const input = '零散记了几笔'
    const built = resolveItems([
      { type: 'expense', amount: 9900, category: '不存在的科目B', description: '大额', date: '2026-10-12', account: '微信' },
      { type: 'expense', amount: 1000, category: '餐饮', description: '小额', date: '2026-10-12', account: '微信' },
    ], NO_OTHER, input)
    const { main } = pickMainItem(built.map((b) => b.item), input)
    expect(main!.description).toBe('小额')
    // 记录现状：Step 2 之前这里会是「大额」（它当时被补了 categories[0] 的分类分）
  })

  it('两笔都完整、只有金额不同 → 金额降序（稀疏路径不参与时不回归）', () => {
    const input = '两笔都齐'
    const built = resolveItems([
      { type: 'expense', amount: 1000, category: '餐饮', description: '小额', date: '2026-10-12', account: '微信' },
      { type: 'expense', amount: 9900, category: '交通', description: '大额', date: '2026-10-12', account: '微信' },
    ], SEEDED, input)
    const { main, droppedCount } = pickMainItem(built.map((b) => b.item), input)
    expect(main!.description).toBe('大额')
    expect(droppedCount).toBe(1)
  })

  it('汇总通知：有货币单位佐证的那笔优先（佐证档 > 完整度档，稀疏与否不影响）', () => {
    const input = '昨天共有2笔支出 昨日支出220.00元'
    const built = resolveItems([
      { type: 'expense', amount: 220, category: '餐饮', description: '餐饮汇总', date: '', account: '' },
      { type: 'expense', amount: 110, category: '其他', description: '', date: '', account: '' },
    ], SEEDED, input)
    const { main } = pickMainItem(built.map((b) => b.item), input)
    expect(main!.description).toBe('餐饮汇总') // 220.00 元有佐证
  })

  it('三笔候选：只回一笔，被裁掉的 2 笔数得对（extra_items_dropped 的来源）', () => {
    const input = '一次记三笔'
    const built = resolveItems([
      { type: 'expense', amount: 300, category: '餐饮', description: '午餐', date: '2026-10-12', account: '微信' },
      { type: 'expense', amount: 200, category: '交通', description: '地铁', date: '2026-10-12', account: '微信' },
      { type: 'expense', amount: 100, category: '不存在的科目C', description: '说不清', date: '2026-10-12', account: '微信' },
    ], NO_OTHER, input)
    const { main, droppedCount } = pickMainItem(built.map((b) => b.item), input)
    expect(droppedCount).toBe(2)
    // 第三笔稀疏（-1 分），前两笔完整度相同 → 金额降序取 300
    expect(main!.description).toBe('午餐')
  })

  it('候选只有一笔 → 原样返回、droppedCount=0（pickMainItem 的短路不受归类影响）', () => {
    const input = '午饭32元'
    const built = resolveItems([
      { type: 'expense', amount: 32, category: '餐饮', description: '午饭', date: '2026-10-12', account: '微信' },
    ], NO_OTHER, input)
    const { main, droppedCount } = pickMainItem(built.map((b) => b.item), input)
    expect(main).toBe(built[0]!.item)
    expect(droppedCount).toBe(0)
  })

  it('转账笔不因没有分类被扣分（category_id=null 仍算完整）', () => {
    const input = '微信转支付宝500'
    const built = resolveItems([
      // 支出笔什么都不全（且归不出来 → null），转账笔只有分类这一项是 null 但豁免计分
      { type: 'expense', amount: 5000, category: '不存在的科目D', description: '', date: '', account: '' },
      { type: 'transfer', amount: 5000, category: '', description: '转账', date: '2026-10-12', account: '微信' },
    ], NO_OTHER, input)
    expect(built[0]!.item.category_id).toBeNull()
    expect(built[1]!.item.category_id).toBeNull()
    const { main } = pickMainItem(built.map((b) => b.item), input)
    expect(main!.type).toBe('transfer')
  })
})