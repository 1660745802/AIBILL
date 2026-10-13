/**
 * 这条测试在锁什么
 * ----------------
 * `resolveCategory` 的五件事（Step 1 重写，Step 2/3/4 加判据，Step 5 收尾）：
 *
 * 1. **主不变量穷举**：对一批 (requested, type, categories, evidenceText) 组合断言
 *    `category_id === null || 该 id ∈ filtered`。这一条是「不编造」的全部技术含义，
 *    也是本次唯一不许破的硬约束——其余判据（长度门槛、极性闸、兜底策略）都可以换，
 *    这条不能。穷举而不是抽样：阶梯有 8 级 × 双向包含 × 排序分支，抽样漏得无声无息。
 *
 * 2. **行为等价对照**：文件里留了一份**重写前实现的只读副本**（`preRewriteMatch`）
 *    当对照系，对 600+ 组合逐个比对新旧结果（id + 名字 + is_exact）。
 *    Step 1 的承诺是「行为 100% 等价」，只靠那 7 条老用例证明不了——
 *    它们恰好没覆盖阶梯的中下段。
 *    ⚠️ Step 2 起等价只对**两边都有「其他」桶**的分类表成立：删掉「第一个分类」兜底
 *    就是一次刻意的行为变更，形状不同的表单独一组用例钉住。
 *
 * 3. **阶梯每一级的可达性**：`it.each(CATEGORY_REASONS)` 全 8 条可达（Step 4 接线后
 *    noise_word 也不再不可达），外加一条反向断言防止枚举漂移。
 *
 * 4. **审计串可读**：`reason_detail` 必须能回答「为什么是这个分类」——
 *    命中的词键、被拒的候选、缺原文时的 `evidence_missing`、噪声闸的命中词条。
 *
 * 5. **噪声闸审计**（Step 4）：窄语境判掉的 / 窄语境放过但宽口径会判的（复核对象）/
 *    两种口径一致的（不塞字段）三种形状都要有。
 *
 * 选笔（`lib/main-item.ts`）与本模块的组合行为另见
 * tests/ai/main-item-selection.test.ts。
*/
import { describe, it, expect } from 'vitest'
import {
  resolveCategory,
  CATEGORY_REASONS,
  type CategoryInfo,
  type CategoryType,
} from '../../src/ai/category-matcher.js'
import { SYNONYMS } from '../../src/ai/synonyms.js'

/* ══ 对照系：重写前的实现，只读副本 ═════════════════════════════════════
 * 逐字照抄 Step 0 的 matchCategory（判定顺序一字不差）。
 * 它存在的唯一意义是回答「Step 1 有没有偷偷改行为」；Step 2 之后再无价值。
 */

function preRewriteFindOther(cs: readonly CategoryInfo[]): CategoryInfo | null {
  const other = cs.find((c) => c.name === '其他')
  if (other) return other
  return cs[0] ?? null
}

function preRewriteMatch(
  raw: string,
  categories: readonly CategoryInfo[],
  type: CategoryType,
): CategoryInfo | null {
  const filtered = categories.filter((c) => c.type === type)
  const name = (raw ?? '').trim()

  if (!name) return preRewriteFindOther(filtered)
  const exact = filtered.find((c) => c.name === name)
  if (exact) return exact
  const contains = filtered.find((c) => name.includes(c.name) || c.name.includes(name))
  if (contains) return contains
  const mapped = SYNONYMS.find((e) => e.key === name)
  if (mapped) {
    const m = filtered.find((c) => c.name === mapped.category)
    if (m) return m
  }
  for (const e of SYNONYMS) {
    if (name.includes(e.key)) {
      const m = filtered.find((c) => c.name === e.category)
      if (m) return m
    }
  }
  return preRewriteFindOther(filtered)
}

/** 重写前的 isExactCategoryMatch（硬编码 `matchedName === '其他'` 返回 false） */
function preRewriteIsExact(requested: string, matchedName: string | null | undefined): boolean {
  if (!matchedName) return false
  if (matchedName === '其他') return false
  return (requested ?? '').trim() === matchedName
}

/* ══ 语料与分类表 ═══════════════════════════════════════════════════════ */

const expense = (names: string[], idBase = 1): CategoryInfo[] =>
  names.map((name, i) => ({ id: idBase + i, name, type: 'expense' as const }))
const income = (names: string[], idBase = 100): CategoryInfo[] =>
  names.map((name, i) => ({ id: idBase + i, name, type: 'income' as const }))

/** 种子用户（schema.ts 那套） */
const SEEDED: CategoryInfo[] = [
  ...expense(['餐饮', '交通', '购物', '住房', '娱乐', '医疗', '教育', '通讯', '日用', '服饰', '人情', '其他']),
  ...income(['工资', '奖金', '理财', '兼职', '红包', '退款', '其他']),
]
/** 用户删掉了「其他」 */
const NO_OTHER: CategoryInfo[] = [...expense(['餐饮', '交通']), ...income(['工资'])]
/** 用户把「餐饮」改名成「餐饮美食」 */
const RENAMED: CategoryInfo[] = [...expense(['餐饮美食', '人情', '其他']), ...income(['工资', '红包', '其他'])]
/** 该 type 一个活跃分类都没有 */
const ONE_TYPE_EMPTY: CategoryInfo[] = [...expense([]), ...income(['工资'])]

/** 病态表：只用于主不变量穷举（行为与重写前有已知差异，见文末两条用例） */
const PATHOLOGICAL: Record<string, CategoryInfo[]> = {
  跨极性同名: [...expense(['餐饮', '人情', '其他']), ...income(['人情', '红包', '其他'])],
  单字分类: [...expense(['衣', '吃', '其他']), ...income(['钱', '其他'])],
}

const NAMES = [
  '', ' ', '  餐饮  ', '餐饮', '交通', '吃饭', '吃的', '外卖', '午餐', '夜宵', '早饭', '食堂',
  '咖啡', '奶茶', '饮料', '水果', '零食', '话费', '流量', '手机', '工资', '薪资', '奖金',
  '年终奖', '红包', '礼物', '份子钱', '请客', '退货', '报销', '退款', '其他',
  '不存在的分类ABC', '未知收入', '吃饭红包', '外卖红包', '餐饮红包', '红包餐饮',
  '礼物与请客', '工资卡', '日用百货', '地铁2', '打车费', '饭', '吃', '奶茶饮料',
  '美团', '房租水电', 'KFC', 'kfc', 'COFFEE', '饭卡', '红包到账', '人情往来',
]
const TYPES: CategoryType[] = ['expense', 'income']
const SETS: Record<string, CategoryInfo[]> = {
  种子用户: SEEDED, 无其他: NO_OTHER, 改名: RENAMED, 单极为空: ONE_TYPE_EMPTY, ...PATHOLOGICAL,
}

function resolveIn(set: CategoryInfo[], type: CategoryType, requested: string) {
  return resolveCategory({ requested, type, categories: set, evidenceText: '某段原文' })
}

describe('resolveCategory · 主不变量穷举（不编造）', () => {
  /** 逐个组合检查，把违规项攒起来一次性报（失败时能一次看到全部破例） */
  function violations(set: CategoryInfo[], type: CategoryType): string[] {
    const filtered = set.filter((x) => x.type === type)
    const out: string[] = []
    for (const requested of NAMES) {
      const res = resolveIn(set, type, requested)
      if (res.category_id !== null && !filtered.some((x) => x.id === res.category_id)) {
        out.push(`「${requested}」→ id=${res.category_id} 不属于该 type 的活跃分类`)
      }
      if (res.category_id === null && (res.category_name !== '' || res.category_icon !== '')) {
        out.push(`「${requested}」→ 无解却回了假名 ${res.category_name}/${res.category_icon}`)
      }
    }
    return out
  }

  it.each(Object.entries(SETS).flatMap(([setName, set]) =>
    TYPES.map((type) => ({ label: `${setName}/${type}`, set, type }))))(
    '$label：category_id 为 null，或真属于该 type 的活跃分类',
    (c) => {
      expect(violations(c.set, c.type)).toEqual([])
    },
  )

  it('组合总数守住了（改了语料要重新数，防「穷举」悄悄退化成抽样）', () => {
    expect(Object.keys(SETS).length * TYPES.length * NAMES.length).toBe(6 * 2 * NAMES.length)
  })
})

describe('resolveCategory · 行为等价对照（对「有『其他』桶」的分类表）', () => {
  /**
   * Step 2 之后，只有**两边都有「其他」桶**的分类表仍与重写前逐条一致
   * （重写前的 findOther 第一级就是「其他」）。没「其他」的表（无其他 / 单极为空）
   * 属于 Step 2 刻意的行为变更，单独一组用例钉住，不混进等价对照。
   * 病态表也不进对照：它们与重写前有两处已知差异（见文末 describe）。
   */
  const equivalenceSets: Array<[string, CategoryInfo[]]> = [['种子用户', SEEDED], ['改名', RENAMED]]
  const evidenceVariants = ['某段原文', '', undefined]

  /**
   * Step 3 刻意的行为变更：L5 不再由词表**声明顺序**决定。
   * `红包到账`（expense）旧实现命中先声明的单字键「包」→服饰（不可解释），
   * 新实现按「key 长度降序」取更具体的「红包」→人情。
   * 这些输入不进等价对照，单独一组用例钉住新行为（见文末 describe）。
   */
  const STEP3_ORDER_CHANGES = new Set(['红包到账'])

  /** 逐个组合比对，把差异攒起来一次性报 */
  function diffs(set: CategoryInfo[], type: CategoryType): string[] {
    const out: string[] = []
    for (const requested of NAMES) {
      if (STEP3_ORDER_CHANGES.has(requested)) continue
      const preRewrite = preRewriteMatch(requested, set, type)
      for (const evidence of evidenceVariants) {
        const res = resolveCategory({
          requested, type, categories: set, evidenceText: evidence,
        })
        const got = `${res.category_id ?? 'null'}:${res.category_name}|exact=${res.is_exact}`
        const want = `${preRewrite ? preRewrite.id : 'null'}:${preRewrite ? preRewrite.name : ''}`
          + `|exact=${preRewriteIsExact(requested, preRewrite?.name ?? null)}`
        if (got !== want) out.push(`「${requested}」evidence=${String(evidence)}：preRewrite=${want} new=${got}`)
      }
    }
    return out
  }

  it.each(equivalenceSets.flatMap(([setName, set]) =>
    TYPES.map((type) => ({ label: `${setName}/${type}`, set, type }))))(
    '$label：归类结果与 is_exact 都与重写前一致',
    (c) => {
      expect(diffs(c.set, c.type)).toEqual([])
    },
  )

})

describe('resolveCategory · 阶梯逐级可达', () => {
  const cases: Array<[string, CategoryType, readonly CategoryInfo[]]> = [
    ['餐饮', 'expense', SEEDED],            // L2 精确
    ['外卖', 'expense', SEEDED],            // L3 同义词整键
    ['餐饮', 'expense', RENAMED],           // L4 受约束包含（方向 B，长度比 = 0.5 刚好）
    ['吃饭红包', 'expense', SEEDED],         // L5 同义词扫描（多候选：key 长度降序 + 等长码位序）
    ['不存在的分类ABC', 'expense', SEEDED],  // L6「其他」桶
    ['不存在的分类ABC', 'expense', NO_OTHER], // L7 留空（没「其他」桶）
    ['餐饮', 'expense', ONE_TYPE_EMPTY],    // L0 极性闸：该 type 无分类
  ]

  it.each(cases)('L? requested=%s type=%s 可达', (requested, type, cats) => {
    const res = resolveCategory({ requested, type, categories: cats, evidenceText: 'x' })
    expect(res.reason_detail.length).toBeGreaterThan(0)
  })

  it('每一级阶梯都有明确 reason（逐条钉住，不靠 it.each(CATEGORY_REASONS) 空转）', () => {
    const seen = new Set(cases.map(([r, t, cats]) =>
      resolveCategory({ requested: r, type: t, categories: cats, evidenceText: 'x' }).reason))
    expect([...seen].sort()).toEqual([
      'contains', 'exact', 'no_candidate', 'other_fallback',
      'synonym_exact', 'synonym_scan', 'undetermined',
    ])
  })

  it('L2 精确命中 → is_exact=true；但「其他」虽是精确命中，is_exact 仍为 false（兜底桶不是精确选择）', () => {
    expect(resolveCategory({ requested: '餐饮', type: 'expense', categories: SEEDED }).is_exact).toBe(true)
    const other = resolveCategory({ requested: '其他', type: 'expense', categories: SEEDED })
    expect(other.reason).toBe('exact')
    expect(other.is_exact).toBe(false)
  })

  it('L3/L4/L5 命中 → is_exact=false（模糊匹配一律 forces 复核）', () => {
    for (const [requested, type, cats] of cases.slice(1, 4)) {
      expect(resolveCategory({ requested, type, categories: cats }).is_exact).toBe(false)
    }
  })


  it('undetermined 从 Step 2 起可达：有分类但没「其他」桶、且归不出来 → 留空', () => {
    const res = resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: NO_OTHER })
    expect(res.reason).toBe('undetermined')
    expect(res.category_id).toBeNull()
    expect(res.category_name).toBe('')
    // 而有「其他」桶的 type 永远不会出 undetermined（Step 2 只删了「第一个分类」兜底）
    for (const set of [SEEDED, RENAMED]) {
      for (const type of TYPES) {
        for (const requested of NAMES) {
          expect(resolveCategory({ requested, type, categories: set }).reason).not.toBe('undetermined')
        }
      }
    }
    expect(CATEGORY_REASONS).toContain('undetermined')
  })
})

describe('resolveCategory · T2 噪声 vs 分类同名（成对矩阵）', () => {
  // 设计 §0.7 的实测样本：广告 7/7 被分流层拦下，但**归类层必须自己也站得住**
  // ——防的是「绕过 STRONG 的渠道」与未来新增的 pass-through 路径。
  const ADS: Array<[string, string]> = [
    ['支付宝卡包 你有淘宝闪购10元红包今晚失效', 'coupon_facevalue'],
    ['您有一个红包未领取 速来淘宝闪购！', 'promo_unclaimed'],
    ['您有闪购外卖红包未查收', 'promo_unclaimed'],
  ]
  const REAL_INCOME: readonly string[] = [
    '你收到一个5.00元红包',
    '好友给你发了一个10元红包，已存入零钱',
    '【微信】你领取了好友的红包 8.88元',
    '你的红包 100.00元 已存入零钱',
  ]

  it.each(ADS)('广告语境 + requested=红包 → noise_word / null：%s', (text) => {
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED, evidenceText: text })
    expect(res.reason).toBe('noise_word')
    expect(res.category_id).toBeNull()
    expect(res.category_name).toBe('')
    expect(res.noise?.source).toBe('narrow')
    expect(res.noise?.term).toBe('红包')
    expect(res.reason_detail).toContain('noise_word')
  })

  it.each(REAL_INCOME)('真实红包收入 → 归收入红包，非 null：%s', (text) => {
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED, evidenceText: text })
    expect(res.reason).not.toBe('noise_word')
    expect(res.category_id).not.toBeNull()
    expect(res.category_name).toBe('红包')
  })

  it('含「领取」的真实收入：窄语境放行，但仍标记为「宽口径会判」的复核判例', () => {
    // Step 0 收窄语境时剔除的正是「领取」，理由就是这句会误杀；
    // Step 4 的决策是「不改宽度，但要看得见」——所以它带 broad 标记而不是被丢掉
    const res = resolveCategory({
      requested: '红包', type: 'income', categories: SEEDED,
      evidenceText: '【微信】你领取了好友的红包 8.88元',
    })
    expect(res.reason).toBe('exact')
    expect(res.category_name).toBe('红包')
    expect(res.noise).toEqual({ term: null, source: 'broad' })
  })

  it('噪声闸优先级高于 L2 精确：用户自己建的「红包」分类也不该赢', () => {
    const userOwns = [...expense(['餐饮', '其他']), ...income(['红包', '其他'])]
    const res = resolveCategory({
      requested: '红包', type: 'income', categories: userOwns,
      evidenceText: '支付宝卡包 你有淘宝闪购10元红包今晚失效',
    })
    expect(res.reason).toBe('noise_word')
    expect(res.category_id).toBeNull()
  })

  it('分流层漏过的句式由这一层兜住：「红包未查收」在 verify 是 tier 2，matcher 判噪声', () => {
    // verify.ts 的 coupon_facevalue 语境词表里**没有** 未查收/未领取，
    // 所以这类广告今天能过分流层 → 归类层的噪声闸是唯一的兜底
    const res = resolveCategory({
      requested: '红包', type: 'income', categories: SEEDED,
      evidenceText: '淘宝闪购10元红包未查收',
    })
    expect(res.reason).toBe('noise_word')
  })
})

describe('resolveCategory · T3 用户分类名遮蔽裸词（误报面 = 0）', () => {
  it('用户自建支出分类「优惠券」+ 证据「优惠券50」→ exact，不判噪声', () => {
    const cats = [...expense(['餐饮', '优惠券', '其他']), ...income(['工资', '其他'])]
    const res = resolveCategory({ requested: '优惠券', type: 'expense', categories: cats, evidenceText: '优惠券50' })
    expect(res.reason).toBe('exact')
    expect(res.category_name).toBe('优惠券')
    expect(res.is_exact).toBe(true)
  })

  it('任何与噪声词同名的用户分类，只要没有语境就照常记账', () => {
    for (const term of ['红包', '立减金', '优惠券', '京东卡']) {
      const cats = [...expense([term, '其他']), ...income(['工资', '其他'])]
      const res = resolveCategory({ requested: term, type: 'expense', categories: cats, evidenceText: `${term}30` })
      expect(res.reason).toBe('exact')
      expect(res.category_name).toBe(term)
    }
  })

  it('缺 evidenceText → 恒不判噪声，且 reason_detail 留 evidence_missing', () => {
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED })
    expect(res.reason).not.toBe('noise_word')
    expect(res.category_name).toBe('红包')
    expect(res.reason_detail).toContain('evidence_missing')
    expect(res.noise).toBeNull()
  })

  it('空串 evidenceText 等同缺失（客户端可能传空）', () => {
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED, evidenceText: '' })
    expect(res.reason).not.toBe('noise_word')
    expect(res.reason_detail).toContain('evidence_missing')
  })
})

describe('resolveCategory · 噪声闸审计：窄语境的决定可复核', () => {
  it('两种口径一致 → 不产生任何审计字段（不给每笔都塞噪音）', () => {
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED, evidenceText: '你收到一个5.00元红包' })
    expect(res.noise).toBeNull()
    expect(res.reason).toBe('exact')
  })

  it('窄语境判掉的 → source=narrow 且带词条', () => {
    const res = resolveCategory({
      requested: '红包', type: 'income', categories: SEEDED,
      evidenceText: '您有闪购外卖红包未查收',
    })
    expect(res.noise).toEqual({ term: '红包', source: 'narrow' })
  })

  it('窄语境放过、宽口径会判的 → source=broad 且 term=null（人工复核对象）', () => {
    // 「优惠券50」：窄语境不含「优惠」→ 放行；verify 的宽语境含「优惠」→ 会判噪声
    const cats = [...expense(['餐饮', '优惠券', '其他']), ...income(['工资', '其他'])]
    const res = resolveCategory({ requested: '优惠券', type: 'expense', categories: cats, evidenceText: '优惠券50' })
    expect(res.reason).toBe('exact')          // 照常归类，不当场杀
    expect(res.noise).toEqual({ term: null, source: 'broad' })
  })
})

describe('resolveCategory · T6 reason 枚举全覆盖（Step 4 起 8 条全部可达）', () => {
  const reachable: Record<string, () => ReturnType<typeof resolveCategory>> = {
    exact: () => resolveCategory({ requested: '餐饮', type: 'expense', categories: SEEDED, evidenceText: '午饭30' }),
    synonym_exact: () => resolveCategory({ requested: '外卖', type: 'expense', categories: SEEDED, evidenceText: '外卖30' }),
    contains: () => resolveCategory({ requested: '餐饮美食外卖', type: 'expense', categories: SEEDED, evidenceText: 'x' }),
    synonym_scan: () => resolveCategory({ requested: '饭红包', type: 'expense', categories: SEEDED, evidenceText: 'x' }),
    noise_word: () => resolveCategory({
      requested: '红包', type: 'income', categories: SEEDED,
      evidenceText: '支付宝卡包 你有淘宝闪购10元红包今晚失效',
    }),
    other_fallback: () => resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: SEEDED, evidenceText: 'x' }),
    undetermined: () => resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: NO_OTHER, evidenceText: 'x' }),
    no_candidate: () => resolveCategory({ requested: '餐饮', type: 'expense', categories: ONE_TYPE_EMPTY, evidenceText: 'x' }),
  }

  it.each(CATEGORY_REASONS)('%s 有可达用例（枚举不得漂移，也不得有不可达的成员）', (reason) => {
    const make = reachable[reason]
    expect(make, `CATEGORY_REASONS 里的 ${reason} 没有对应用例`).toBeTypeOf('function')
    expect(make!().reason).toBe(reason)
  })

  it('反过来：没有 reason 落在枚举之外', () => {
    const seen = new Set(Object.values(reachable).map((f) => f().reason))
    for (const r of seen) expect(CATEGORY_REASONS).toContain(r)
  })

  it('枚举本身：8 条、不重复（Step 5 全覆盖核对：0 条不可达）', () => {
    expect(CATEGORY_REASONS).toHaveLength(8)
    expect(new Set(CATEGORY_REASONS).size).toBe(CATEGORY_REASONS.length)
    // 可达用例的条数与枚举条数一致 → 没有任何 reason 是「写在枚举里但走不到」
    expect(Object.keys(reachable).sort()).toEqual([...CATEGORY_REASONS].sort())
  })
})

describe('resolveCategory · reason_detail 可审计', () => {
  it('同义词整键/扫描：写清命中的是哪个词键、指向哪个分类', () => {
    const exact = resolveCategory({ requested: '外卖', type: 'expense', categories: SEEDED })
    expect(exact.reason_detail).toContain('外卖')
    expect(exact.reason_detail).toContain('餐饮')
    const scan = resolveCategory({ requested: '吃饭红包', type: 'expense', categories: SEEDED })
    expect(scan.reason_detail).toContain('ranked=')
    expect(scan.reason_detail).toContain('吃饭')
    // 被拒的候选也必须出现（否则无法审计「为什么不是它」）
    expect(scan.reason_detail).toContain('红包→人情')
  })

  it('包含匹配：写清全部候选（含被拒的）', () => {
    const res = resolveCategory({ requested: '餐饮外卖交通美食', type: 'expense', categories: SEEDED })
    expect(res.reason).toBe('contains')
    expect(res.reason_detail).toContain('candidates=')
    expect(res.reason_detail).toContain('len=')
    expect(res.reason_detail).toContain('餐饮')
    expect(res.reason_detail).toContain('交通')
  })

  it('L4 三个门槛：方向 A 直接接受 / 方向 B 需长度比 ≥ 0.5 / 不足则不放行', () => {
    // 方向 A：模型给得更长（餐饮美食 ⊂ 请求名）
    const a = resolveCategory({ requested: '餐饮美食外卖', type: 'expense', categories: SEEDED })
    expect(a.reason).toBe('contains')
    expect(a.category_name).toBe('餐饮')
    // 方向 B：模型给得更短，比值 2/4 = 0.5 → 接受
    const b = resolveCategory({ requested: '餐饮', type: 'expense', categories: RENAMED })
    expect(b.reason).toBe('contains')
    expect(b.category_name).toBe('餐饮美食')
    // 比值 2/6 < 0.5 → 不接受，转兜底桶（宁可给「其他」也不给一个语义上错的分类）
    const short = resolveCategory({ requested: '餐饮', type: 'expense', categories: expense(['餐饮美食馆', '其他']) })
    expect(short.reason).toBe('other_fallback')
    expect(short.category_name).toBe('其他')
  })

  it('L7 留空：reason_detail 说清走完了阶梯、候选是什么、为何都没接受', () => {
    const res = resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: NO_OTHER })
    expect(res.reason).toBe('undetermined')
    expect(res.reason_detail).toContain('不存在的分类ABC')
    expect(res.reason_detail).toContain('candidates=[')
    // 该 type 的全部分类就是「候选集合」——审计者能看出确实翻过一遍
    expect(res.reason_detail).toContain('餐饮')
    expect(res.reason_detail).toContain('交通')
    expect(res.reason_detail).toContain('没有「其他」桶')
    // 旧实现会给「第一个分类」（餐饮），reason_detail 里不许再出现它
    expect(res.reason_detail).not.toContain('legacy_first_category')
  })

  it('无原文时打 evidence_missing 标记（噪声闸退化为「只看裸词」，审计上要看得见）', () => {
    const withText = resolveCategory({ requested: '外卖', type: 'expense', categories: SEEDED, evidenceText: '外卖30' })
    const without = resolveCategory({ requested: '外卖', type: 'expense', categories: SEEDED })
    expect(withText.reason_detail).not.toContain('evidence_missing')
    expect(without.reason_detail).toContain('evidence_missing')
    // 标记只影响审计，不影响判定结果
    expect(without.category_id).toBe(withText.category_id)
    expect(without.reason).toBe(withText.reason)
  })

  it('requested 为 null/undefined 不抛错（模型经常不给分类名）', () => {
    for (const requested of [null, undefined]) {
      const res = resolveCategory({ requested, type: 'expense', categories: SEEDED })
      expect(res.category_name).toBe('其他')
    }
  })
})

describe('resolveCategory · Step 2：归不出来就留空（唯一编造路径已删）', () => {
  it('没有「其他」桶时返回 null，而不是第一个分类（种子分类的第一项是「餐饮」）', () => {
    // 重写前的 findOther 第二级：categories[0] = 餐饮（id=1）
    expect(preRewriteMatch('不存在的分类ABC', NO_OTHER, 'expense')?.id).toBe(1)
    const res = resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: NO_OTHER })
    expect(res.category_id).toBeNull()
    expect(res.category_name).toBe('')
    expect(res.category_icon).toBe('')
    expect(res.reason).toBe('undetermined')
    expect(res.is_exact).toBe(false)
  })

  it('有「其他」桶时行为不变（仍然是 other_fallback，不是 null）', () => {
    for (const set of [SEEDED, RENAMED]) {
      const res = resolveCategory({ requested: '不存在的分类ABC', type: 'expense', categories: set })
      expect(res.reason).toBe('other_fallback')
      expect(res.category_name).toBe('其他')
    }
  })

  it('该 type 只有一个分类、且不是「其他」时，同样留空（单极表的老兜底也没了）', () => {
    // 重写前：categories[0] = 工资；现在：null
    expect(preRewriteMatch('不存在的科目', ONE_TYPE_EMPTY, 'income')?.name).toBe('工资')
    const res = resolveCategory({ requested: '不存在的科目', type: 'income', categories: ONE_TYPE_EMPTY })
    expect(res.category_id).toBeNull()
    expect(res.reason).toBe('undetermined')
  })

  it('硬不变量不被这一步破坏：穷举里所有非 null 结果仍 ∈ 该 type 的活跃分类', () => {
    // 本文件开头的「主不变量穷举」已覆盖全部组合；这里再钉一次最容易被写坏的那个形状
    for (const requested of NAMES) {
      const res = resolveCategory({ requested, type: 'expense', categories: NO_OTHER })
      if (res.category_id !== null) {
        expect(NO_OTHER.some((c) => c.type === 'expense' && c.id === res.category_id)).toBe(true)
      }
    }
  })
})

describe('resolveCategory · T1 极性矩阵（红包两向）', () => {
  it('红包 + income + 用户有收入「红包」分类 → 收入红包，reason=exact', () => {
    const incomeRedpacket = SEEDED.find((c) => c.type === 'income' && c.name === '红包')!
    const res = resolveCategory({ requested: '红包', type: 'income', categories: SEEDED })
    expect(res.category_id).toBe(incomeRedpacket.id)
    expect(res.category_name).toBe('红包')
    expect(res.reason).toBe('exact')
    expect(res.is_exact).toBe(true)
  })

  it('红包 + expense + 用户有人情 → 人情，reason=synonym_exact', () => {
    const res = resolveCategory({ requested: '红包', type: 'expense', categories: SEEDED })
    expect(res.category_name).toBe('人情')
    expect(res.reason).toBe('synonym_exact')
    expect(res.reason_detail).toContain('expense')
  })

  it('红包 + expense + 用户**没有**人情 → 候选丢弃，绝不返回人情', () => {
    const noRenqing = [...expense(['餐饮', '交通', '其他']), ...income(['工资', '红包', '其他'])]
    const res = resolveCategory({ requested: '红包', type: 'expense', categories: noRenqing })
    expect(res.category_name).not.toBe('人情')
    if (res.category_id !== null) {
      expect(noRenqing.some((c) => c.type === 'expense' && c.id === res.category_id)).toBe(true)
    }
    expect(['other_fallback', 'undetermined']).toContain(res.reason)
  })

  it('红包 + income + 用户删掉了收入「红包」分类 → 不得返回 expense 的人情', () => {
    // 用户删了收入红包、又没有「人情」：income 词条目标不存在 → 丢弃
    const deleted = [...expense(['餐饮', '人情', '其他']), ...income(['工资', '奖金', '其他'])]
    const res = resolveCategory({ requested: '红包', type: 'income', categories: deleted })
    expect(res.category_name).not.toBe('人情')
    expect(res.reason).toBe('other_fallback')
    expect(res.category_name).toBe('其他')
  })

  it('红包 + income + 用户删了收入红包、又没有人情 → 留空而不是掉到 expense 人情', () => {
    const deleted = [...expense(['餐饮', '人情']), ...income(['工资'])]
    const res = resolveCategory({ requested: '红包', type: 'income', categories: deleted })
    expect(res.category_id).toBeNull()
    expect(res.reason).toBe('undetermined')
  })
})

describe('resolveCategory · T4 不再由词表声明顺序决定（L5 排序规则）', () => {
  it('唯一最长键胜出：饭红包 → 红包（人情），不是先声明的单字键「饭」→餐饮', () => {
    // 重写前：3.1 步按声明顺序，先命中「饭」→餐饮
    expect(preRewriteMatch('饭红包', SEEDED, 'expense')?.name).toBe('餐饮')
    const res = resolveCategory({ requested: '饭红包', type: 'expense', categories: SEEDED })
    expect(res.reason).toBe('synonym_scan')
    expect(res.category_name).toBe('人情')
    expect(res.reason_detail).toContain('红包→人情')
    // 审计串里能看出排序依据与被拒候选
    expect(res.reason_detail).toContain('长度降序')
    expect(res.reason_detail).toContain('饭→餐饮')
  })

  it('单字键不得压过更长的键：红包到账 → 人情，而不是先声明的「包」→服饰', () => {
    expect(preRewriteMatch('红包到账', SEEDED, 'expense')?.name).toBe('服饰')
    const res = resolveCategory({ requested: '红包到账', type: 'expense', categories: SEEDED })
    expect(res.category_name).toBe('人情')
    expect(res.reason_detail).toContain('包→服饰') // 被拒候选仍在审计串里
  })

  it('等长多候选 → 码位序升序（吃 U+5403 < 红 U+7EA2），结果由规则算出而非表顺序', () => {
    const res = resolveCategory({ requested: '吃饭红包', type: 'expense', categories: SEEDED })
    expect(res.reason).toBe('synonym_scan')
    expect(res.reason_detail).toContain('吃饭→餐饮')
    // 等长时码位序在前的是「吃饭」，所以赢家也是吃饭→餐饮 —— 但这是规则的结果
    expect(res.reason_detail.indexOf('吃饭→餐饮')).toBeLessThan(res.reason_detail.indexOf('红包→人情'))
  })

  it('唯一最长（4 字键）压过 2 字键：视频会员红包 → 娱乐', () => {
    const res = resolveCategory({ requested: '视频会员红包', type: 'expense', categories: SEEDED })
    expect(res.reason).toBe('synonym_scan')
    expect(res.category_name).toBe('娱乐')
  })
})

describe('resolveCategory · 极性闸：expense 请求永远看不到 income 桶的词条', () => {
  it('同名不同极性：收入侧的「红包」词条在 expense 请求下拿不到', () => {
    // 只有收入侧存在「红包」分类表项的形状：expense 请求「红包」→ 只能走 expense 词条
    const onlyIncomeBucket = [...expense(['餐饮', '其他']), ...income(['工资', '红包', '其他'])]
    const expenseRes = resolveCategory({ requested: '红包', type: 'expense', categories: onlyIncomeBucket })
    expect(expenseRes.category_name).not.toBe('红包')
    expect(expenseRes.category_name).toBe('其他')
    const incomeRes = resolveCategory({ requested: '红包', type: 'income', categories: onlyIncomeBucket })
    expect(incomeRes.category_name).toBe('红包')
  })

  it('工资类词条同理：income 的「工资」不会给 expense 请求用', () => {
    const res = resolveCategory({ requested: '工资', type: 'expense', categories: SEEDED })
    expect(res.category_name).not.toBe('工资')
    expect(res.category_name).toBe('其他')
  })
})

describe('resolveCategory · 与重写前的两处已知差异（阶梯规则要求，钉住不回归）', () => {
  const cross = PATHOLOGICAL['跨极性同名']!

  it('极性闸：income 请求不再命中 expense 同义词，哪怕用户恰好有个 income 的「人情」', () => {
    // 旧实现会给 income 人情（3.1 步不看极性）；现在走 L3 极性闸 → L6「其他」桶
    expect(preRewriteMatch('礼物', cross, 'income')?.name).toBe('人情')
    const res = resolveCategory({ requested: '礼物', type: 'income', categories: cross })
    expect(res.reason).toBe('other_fallback')
    expect(res.category_name).toBe('其他')
  })

  it('L4 长度门槛：长度为 1 的包含候选一律不接受（除非 exact）', () => {
    const short = PATHOLOGICAL['单字分类']!
    expect(preRewriteMatch('吃饭', short, 'expense')?.name).toBe('吃')
    const res = resolveCategory({ requested: '吃饭', type: 'expense', categories: short })
    expect(res.reason).toBe('other_fallback')
    expect(res.category_name).not.toBe('吃')
    // 单字分类仍可被 exact 命中（L2 早于长度门槛）
    expect(resolveCategory({ requested: '吃', type: 'expense', categories: short }).category_name).toBe('吃')
  })
})