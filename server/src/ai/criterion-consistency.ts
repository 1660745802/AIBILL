/**
 * 判据一致性断言（候选 06 · Step 0，零行为变更）
 *
 * 问题的形状：同一个词在服务端**几层判据里各有一份表**，极性（expense/income）
 * 没有编码进词表，于是一层说「红包 = 人情支出」、另一层说「红包 = 红包收入」，
 * 两边都「正常运行」，没有任何一处会响（设计 §0.6 / 现场 bug B）。
 *
 * 这个模块是**纯函数**：无 IO、无 DB、不读 config/rules.json。
 * 它只回答一个问题：给定一组词表，彼此之间有没有矛盾。
 *
 * 两条导出：
 *   collectCriterionConflicts(tables?) → Conflict[]（空数组 = 通过）
 *   assertCriterionConsistency(tables?) → void（非空即 throw，fail-fast）
 *
 * 参数化是为了让断言逻辑本身可测：**用故意构造的坏表断言它会报错**，
 * 而不是对真实常量断言「全绿」——C1/C2 在今天本来是红的（那正是 Step 3/4 要修的），
 * 对真实常量跑绿断言等于提前把没修的东西写成期望行为。
 *
 * 断言清单 C1..C7 对应设计 §3.3；判据实现在 `criterion-checks.ts`。
 * C6/C7 需要 rules.json 的词表与语料，而本模块禁止 IO，所以它们做成**可选入参**
 * （`tables.rules`），缺省不参与断言，由挂载点（Step 7）读文件后传入。
 */

import { NOISE_TERMS } from './noise-terms.js'
import { SYNONYMS } from './synonyms.js'
import { HIGH_CONFIDENCE_MAP } from './quick-parser.js'
import { CATEGORY_RULES } from '../lib/import-matcher.js'
import { SEED_EXPENSE_NAMES, SEED_INCOME_NAMES } from '../db/schema.js'
import { PROMPT_NOISE_EXAMPLES } from './prompts.js'
import { CRITERION_CHECKS } from './criterion-checks.js'

/** 交易类型（极性） */
export type TxnType = 'expense' | 'income'

/** 冲突类别（穷举，便于程序化断言） */
export type ConflictKind =
  | 'synonym_polarity_missing'
  | 'polarity_conflict'
  | 'synonym_target_missing'
  | 'prompt_example_not_noise'
  | 'noise_term_missing_context'
  | 'noise_bare_term_matches_seed_category'
  | 'noise_bare_term_matches_synonym'
  | 'client_block_vs_server_positive'
  | 'testcase_missing_expect_client'
  | 'cross_table_word_conflict'

export interface Conflict {
  readonly kind: ConflictKind
  /** 出问题的词（或 testcase / prompt 例句的 id） */
  readonly term: string
  /** 所在常量表（形如 `ai/synonyms.SYNONYMS`） */
  readonly where: string
  /** 建议动作 */
  readonly hint: string
  /**
   * 冲突涉及的极性。只有「跨表词条」类判据（C2 / C8）会填——
   * 词表的矛盾必须能定位到 (词, 极性) 才查得动，光有词不够。
   */
  readonly polarity?: TxnType
}

/**
 * 一条判据：输入一组词表，输出它能发现的矛盾。
 * 实现在 criterion-checks.ts（C1..C7）与 criterion-cross-table.ts（C8），
 * 由本文件的 CRITERION_CHECKS 汇总——类型放在这里是因为两边都要用它。
 */
export type CriterionCheck = (tables: CriterionTables) => readonly Conflict[]

/* ── 输入形状 ──────────────────────────────────────────────────────────
 * 刻意做得「可缺」：坏表（缺 type、缺 context）必须能被构造出来，
 * 否则断言只能验好表、永远验不到自己抓的是什么。
 */

export interface SynonymInput {
  readonly key: string
  readonly category: string
  /** 缺 = 今天的写法（极性靠目标分类在哪一桶隐式决定）→ C1 红 */
  readonly type?: TxnType
}

export interface QuickConfidenceInput {
  readonly key: string
  readonly category: string
  readonly type?: TxnType
}

export interface ImportRuleInput {
  readonly keywords: readonly string[]
  readonly category: string
  /** 缺 = 不限极性（不算极性声明，不参与 C2 比对） */
  readonly types?: readonly TxnType[]
}

export interface NoiseTermInput {
  readonly term: string
  /** 缺 = 裸词 → C5 红。NOISE_TERMS 里它是必填，这里放宽是为了能构造坏表 */
  readonly context?: RegExp
  readonly reason?: string
}

export interface PromptExampleInput {
  readonly id: string
  readonly text: string
}

/** config/rules.json 那一侧（C6/C7 用；IO 由挂载点做，本模块只收已解析好的值） */
export interface RulesCriterionInput {
  /** 客户端拦截词：a11y.common_exclude_keywords / wechat_alipay_exclude_keywords / sms.spam_keywords / processor.marketing_suffix_cutoffs */
  readonly clientBlockKeywords: ReadonlyArray<{ readonly term: string; readonly where: string }>
  /** 服务端正向判据的字面量 token：payment_signal_regex 的字面量 ∪ PAYMENT_VERB */
  readonly serverPositiveTokens: readonly string[]
  /** 显式豁免：每条附一句「为什么无害」，不许通配（设计 §3.3 C6） */
  readonly allowedOverlaps: ReadonlyArray<{ readonly term: string; readonly why: string }>
  readonly testcases: ReadonlyArray<{
    readonly id: string
    readonly expect_txn?: boolean
    readonly expect_client?: string
  }>
}

export interface CriterionTables {
  readonly synonyms: readonly SynonymInput[]
  readonly quickConfidence: readonly QuickConfidenceInput[]
  readonly importRules: readonly ImportRuleInput[]
  readonly noiseTerms: readonly NoiseTermInput[]
  readonly seedExpenseNames: readonly string[]
  readonly seedIncomeNames: readonly string[]
  readonly promptNoiseExamples: readonly PromptExampleInput[]
  /** 缺省不参与断言：C6/C7 需要 rules.json，而本模块禁止 IO */
  readonly rules?: RulesCriterionInput
}

/** 真实常量（发布期挂载点与 Step 3/4 的默认值用） */
function realCriterionTables(): CriterionTables {
  return {
    synonyms: SYNONYMS.map((e) => ({ key: e.key, category: e.category, type: e.type })),
    quickConfidence: Object.entries(HIGH_CONFIDENCE_MAP).map(([key, v]) => ({
      key,
      category: v.category,
      type: v.type,
    })),
    importRules: CATEGORY_RULES,
    noiseTerms: NOISE_TERMS,
    seedExpenseNames: SEED_EXPENSE_NAMES,
    seedIncomeNames: SEED_INCOME_NAMES,
    promptNoiseExamples: PROMPT_NOISE_EXAMPLES,
  }
}

/**
 * 收集所有跨层矛盾。空数组 = 通过。
 * @param tables 缺省读代码内真实常量（C6/C7 需 rules.json，故缺省不参与）
 */
export function collectCriterionConflicts(
  tables: CriterionTables = realCriterionTables(),
): Conflict[] {
  return CRITERION_CHECKS.flatMap((check) => check(tables))
}

/** 抛错消息里最多逐条列这么多条，剩下的只报总数（不静默丢） */
const MAX_LISTED = 20

/**
 * fail-fast：非空即抛。消息逐条给「kind + 词 + 所在常量表 + 建议动作」（设计 §3.4）。
 * @throws Error 有任一层判据互相矛盾时
 */
export function assertCriterionConsistency(tables: CriterionTables = realCriterionTables()): void {
  const conflicts = collectCriterionConflicts(tables)
  if (conflicts.length === 0) return
  const listed = conflicts
    .slice(0, MAX_LISTED)
    .map((c) => `- [${c.kind}] 「${c.term}」@${c.where}：${c.hint}`)
    .join('\n')
  const rest = conflicts.length - MAX_LISTED
    ? `\n…另有 ${conflicts.length - MAX_LISTED} 条同类冲突`
    : ''
  throw new Error(`判据一致性检查失败（${conflicts.length} 条）：\n${listed}${rest}`)
}