/**
 * 这条测试在锁什么
 * ----------------
 * 判据一致性断言（criterion-consistency.ts）的**判定能力**，锁三件事：
 *
 * 1. **每条判据在遇到「坏表」时真的会报错**（C1..C8 各一组）——
 *    断言不是装饰：把词表换成故意矛盾的样子，它必须指出是哪一条矛盾、哪个词、
 *    在哪张表、建议怎么改。没有这一组，`assertCriterionConsistency` 可以永远返回空、
 *    永远绿灯，而线上照样跨层打架。
 * 2. **断言不是永真**：一张明显干净的假表必须返回空数组、不抛错；
 *    C8 另有一组「把冲突修掉就归零」的反向用例。
 *    只测「会报错」的断言，最容易的写法就是恒返回真 —— 这一条专门防它。
 * 3. **合法双极性不被误报**：「红包」同时是支出（发红包 → 人情）和收入
 *    （收到红包 → 红包分类）是产品要保留的设计，断言不能把它当矛盾（设计 §3.5）。
 *
 * C8（synonyms ↔ import-matcher 的交叉一致性）在这里只验**坏表**能报；
 * 它对真实常量的断言要等同义词表有显式极性之后才有意义（那时 SYNONYMS 才真的
 * 声明了 (词, 极性)），那时再补 characterization 锁。
 *
 * ⚠️ 本文件**不整体断言真实常量全绿**：C1..C7 对今天的真实常量已经是绿的，
 * 但它们对**假表**的判定能力才是这里要锁的东西（Step 7 才把断言挂到发布路径上）。
 */
import { describe, it, expect } from 'vitest'
import {
  collectCriterionConflicts,
  assertCriterionConsistency,
  type CriterionTables,
} from '../../src/ai/criterion-consistency.js'

/** 极性桶形态的假表（设计 §2.3 R1 的目标形态：红包两个极性都在） */
function cleanTables(): CriterionTables {
  return {
    synonyms: [
      { key: '吃饭', category: '餐饮', type: 'expense' },
      { key: '红包', category: '人情', type: 'expense' },
      { key: '红包', category: '红包', type: 'income' },
    ],
    quickConfidence: [{ key: '红包', category: '红包', type: 'income' }],
    importRules: [
      { keywords: ['红包'], category: '人情', types: ['expense'] },
      { keywords: ['红包'], category: '红包', types: ['income'] },
    ],
    noiseTerms: [{ term: '红包', context: /(?:失效|未查收|未领取)/, reason: 'coupon_facevalue' }],
    seedExpenseNames: ['餐饮', '人情', '其他'],
    seedIncomeNames: ['工资', '红包', '其他'],
    promptNoiseExamples: [
      { id: 'coupon_expired', text: '支付宝卡包 你有淘宝闪购10元红包今晚失效' },
    ],
    rules: {
      clientBlockKeywords: [{ term: '朋友圈', where: 'a11y.wechat_alipay_exclude_keywords' }],
      serverPositiveTokens: ['退款', '转账', '消费'],
      allowedOverlaps: [],
      testcases: [
        { id: 'sms-bank-consume-debit', expect_txn: true, expect_client: 'pass' },
        { id: 'a11y-wallet-balance-page', expect_txn: false },
      ],
    },
  }
}

/** 在干净假表上局部改坏，用于逐条构造坏表 */
function broken(overrides: Partial<CriterionTables>): CriterionTables {
  return { ...cleanTables(), ...overrides }
}

function kindsOf(t: CriterionTables): string[] {
  return collectCriterionConflicts(t).map((c) => c.kind)
}

/** 某类冲突（一张坏表常常同时触发多条判据，断言按 kind 取，别写死数组顺序） */
function conflictsOf(t: CriterionTables, kind: string) {
  return collectCriterionConflicts(t).filter((c) => c.kind === kind)
}

/** 真实常量（collectCriterionConflicts 的默认入参）下的某一类冲突 */
function realConflictsOf(kind: string) {
  return collectCriterionConflicts().filter((c) => c.kind === kind)
}

describe('判据一致性断言 · 坏表必报', () => {
  it('C1 · 同义词条目缺 type（今天的 SYNONYMS 写法）→ 报极性缺失', () => {
    const t = broken({ synonyms: [{ key: '吃饭', category: '餐饮' }] })
    const conflicts = collectCriterionConflicts(t)
    expect(conflicts.map((c) => c.kind)).toContain('synonym_polarity_missing')
    expect(conflicts[0]!.term).toBe('吃饭')
    expect(conflicts[0]!.where).toBe('ai/synonyms.SYNONYMS')
    expect(() => assertCriterionConsistency(t)).toThrow(/synonym_polarity_missing/)
  })

  it('C2 · 同一 (词, 极性) 在两张表里指向不同目标分类 → 报跨表极性冲突', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情', type: 'expense' }],
      importRules: [{ keywords: ['红包'], category: '礼物', types: ['expense'] }],
    })
    const conflicts = conflictsOf(t, 'polarity_conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.term).toBe('红包')
    expect(conflicts[0]!.where).toContain('ai/synonyms.SYNONYMS')
    expect(conflicts[0]!.where).toContain('import-matcher.CATEGORY_RULES')
    expect(conflicts[0]!.hint).toContain('人情')
    expect(conflicts[0]!.hint).toContain('礼物')
    expect(() => assertCriterionConsistency(t)).toThrow(/polarity_conflict.*红包/s)
  })

  it('C2 · 「红包」的双极性不是冲突（quick=income 与 matcher=expense 服务不同语境）', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情', type: 'expense' }],
      quickConfidence: [{ key: '红包', category: '红包', type: 'income' }],
      importRules: [],
    })
    expect(conflictsOf(t, 'polarity_conflict')).toEqual([])
  })

  it('C2 · 真实常量今天无跨表极性冲突（(红包,expense) 都是人情，(红包,income) 都是红包）', () => {
    expect(realConflictsOf('polarity_conflict')).toEqual([])
  })

  it('C2 · 合法双极性（红包既有 expense 又有 income）不得误报', () => {
    // cleanTables 就是这个形态：极性桶两端都在，quick 只声明 income
    expect(kindsOf(cleanTables())).not.toContain('polarity_conflict')
  })

  it('C3 · 同义词目标不在同极性的种子表里 → 报死词（含「目标只在另一桶」）', () => {
    const t = broken({ synonyms: [{ key: '红包', category: '红包', type: 'expense' }] })
    const conflicts = conflictsOf(t, 'synonym_target_missing')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.hint).toContain('红包')
    // 目标名存在、但在 income 桶里，对 expense 词条照样是死词
    expect(cleanTables().seedIncomeNames).toContain('红包')
  })

  it('C4 · prompt 的「不是账」例句被判成账 → 报跨层语义矛盾', () => {
    const t = broken({
      promptNoiseExamples: [{ id: 'wechat_paid', text: '微信支付 已支付¥4.20' }],
    })
    expect(kindsOf(t)).toContain('prompt_example_not_noise')
  })

  it('C5 · 噪声条目缺 context（裸词判噪声）→ 三条一起报', () => {
    const t = broken({
      synonyms: [{ key: '优惠券', category: '餐饮', type: 'expense' }],
      seedExpenseNames: ['餐饮', '优惠券', '其他'],
      noiseTerms: [{ term: '优惠券', reason: 'coupon_facevalue' }],
    })
    const kinds = kindsOf(t)
    expect(kinds).toContain('noise_term_missing_context')
    expect(kinds).toContain('noise_bare_term_matches_seed_category')
    expect(kinds).toContain('noise_bare_term_matches_synonym')
  })

  it('C5 · 带了 context 的同名噪声词不算裸词（误报面 = 0）', () => {
    const t = broken({
      noiseTerms: [{ term: '优惠券', context: /(?:满减|失效|待领)/, reason: 'coupon_facevalue' }],
      seedExpenseNames: ['餐饮', '优惠券', '其他'],
    })
    expect(kindsOf(t)).not.toContain('noise_term_missing_context')
    expect(kindsOf(t)).not.toContain('noise_bare_term_matches_seed_category')
  })

  it('C6 · 客户端拦、服务端认（退款）→ 报反向词；写进显式豁免后放行', () => {
    const rules = {
      clientBlockKeywords: [{ term: '申请退款', where: 'a11y.common_exclude_keywords' }],
      serverPositiveTokens: ['退款', '转账', '消费'],
      allowedOverlaps: [],
      testcases: [],
    }
    const bad = broken({ rules })
    const conflicts = conflictsOf(bad, 'client_block_vs_server_positive')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.term).toBe('申请退款')
    // 豁免必须显式列出（不许通配），列出后即放行
    const exempted = broken({
      rules: { ...rules, allowedOverlaps: [{ term: '申请退款', why: '只拦「申请中」，到账另说' }] },
    })
    expect(kindsOf(exempted)).not.toContain('client_block_vs_server_positive')
  })

  it('C7 · 真交易语料缺 expect_client=pass → 报意图护栏缺失；非交易语料不报', () => {
    const rules = {
      clientBlockKeywords: [],
      serverPositiveTokens: ['退款'],
      allowedOverlaps: [],
      testcases: [
        { id: 'sms-bank-consume-debit', expect_txn: true },
        { id: 'ad-coupon', expect_txn: false, expect_client: 'pass' },
      ],
    }
    const conflicts = conflictsOf(broken({ rules }), 'testcase_missing_expect_client')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.term).toBe('sms-bank-consume-debit')
  })

  it('缺 rules 入参时 C6/C7 不参与（rules.json 的 IO 由挂载点做）', () => {
    const { rules: _rules, ...noRules } = cleanTables()
    expect(kindsOf(noRules)).toEqual([])
  })

  it('C8 · 两份「词 → 分类」表对同一 (词,极性) 指向不同目标 → 报交叉冲突', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情', type: 'expense' }],
      importRules: [{ keywords: ['红包'], category: '礼物', types: ['expense'] }],
    })
    const conflicts = conflictsOf(t, 'cross_table_word_conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.term).toBe('红包')
    expect(conflicts[0]!.polarity).toBe('expense')
    expect(conflicts[0]!.where).toContain('ai/synonyms.SYNONYMS')
    expect(conflicts[0]!.where).toContain('import-matcher.CATEGORY_RULES')
    expect(conflicts[0]!.hint).toContain('人情')
    expect(conflicts[0]!.hint).toContain('礼物')
  })

  it('C8 · 同一 (词,极性) 两边目标一致 → 不报（84/45 条同向重叠正是这一类）', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情', type: 'expense' }],
      importRules: [{ keywords: ['红包'], category: '人情', types: ['expense'] }],
    })
    expect(conflictsOf(t, 'cross_table_word_conflict')).toEqual([])
  })

  it('C8 · import 的 types 缺省 = 不限极性，对两个极性都算声明', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情', type: 'expense' }],
      importRules: [{ keywords: ['红包'], category: '红包' }], // 无 types
    })
    // 不限极性 ⇒ import 在两个极性上都声明了「红包 → 红包」：
    //   expense 上与 SYNONYMS 的「人情」直接矛盾（①）
    //   income  上 SYNONYMS 没声明、只拿另一极性的「人情」比（②）
    expect(conflictsOf(t, 'cross_table_word_conflict').map((c) => c.polarity).sort())
      .toEqual(['expense', 'income'])
  })
})

describe('判据一致性断言 · 不是永真', () => {
  it('干净的假表 → 空数组且不抛错（证明上面那些红不是恒真写出来的）', () => {
    const t = cleanTables()
    expect(collectCriterionConflicts(t)).toEqual([])
    expect(() => assertCriterionConsistency(t)).not.toThrow()
  })

  it('每条冲突都带 kind + 词 + 所在表 + 建议动作（fail-fast 消息可定位）', () => {
    const t = broken({ synonyms: [{ key: '吃饭', category: '餐饮' }] })
    const conflicts = collectCriterionConflicts(t)
    expect(conflicts.length).toBeGreaterThan(0)
    for (const c of conflicts) {
      expect(c.kind.length).toBeGreaterThan(0)
      expect(c.term.length).toBeGreaterThan(0)
      expect(c.where.length).toBeGreaterThan(0)
      expect(c.hint.length).toBeGreaterThan(10)
    }
  })

  it('坏表 → assert 抛错且消息里能看出是哪条矛盾', () => {
    const t = broken({
      synonyms: [{ key: '红包', category: '人情' }],
      quickConfidence: [{ key: '红包', category: '红包', type: 'income' }],
      importRules: [],
    })
    expect(() => assertCriterionConsistency(t)).toThrow(Error)
    expect(() => assertCriterionConsistency(t)).toThrow(/判据一致性检查失败/)
    expect(() => assertCriterionConsistency(t)).toThrow(/红包/)
  })
})