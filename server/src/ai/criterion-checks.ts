/**
 * 判据一致性断言 · C1..C7 的具体判据（候选 06 · Step 0，零行为变更）
 *
 * 与 `criterion-consistency.ts` 的分工：那边是**入口**（收集 + fail-fast 抛错），
 * 这边是**判据**（每条一个纯函数，输入一组词表、输出冲突列表）。
 * 一条判据一个函数，所以「断言逻辑本身」可以被假表逐条覆盖
 * （tests/ai/criterion-consistency.test.ts）。
 *
 * ⚠️ 这里只 import **类型**（`import type` 编译后即被抹掉），运行时不会与入口成环。
 */
import { classifyNotification } from './verify.js'
import { checkCrossTableWordConflict } from './criterion-cross-table.js'
import type {
  Conflict,
  CriterionTables,
  CriterionCheck,
  TxnType,
} from './criterion-consistency.js'
// 位置标签的真实定义在 criterion-where.ts（C8 也要用同一份，放这里会与 C8 成环）
import {
  WHERE_SYNONYMS, WHERE_QUICK, WHERE_IMPORT, WHERE_NOISE, WHERE_PROMPT,
} from './criterion-where.js'

export { WHERE_SYNONYMS, WHERE_QUICK, WHERE_IMPORT, WHERE_NOISE, WHERE_PROMPT }
export type { CriterionCheck }

function seedNamesOf(type: TxnType, t: CriterionTables): readonly string[] {
  return type === 'expense' ? t.seedExpenseNames : t.seedIncomeNames
}

/** 目标分类落在哪个种子桶（今天 SYNONYMS 那个「隐式极性」的还原口径） */
function seedBucketOf(category: string, t: CriterionTables): TxnType | null {
  if (t.seedExpenseNames.includes(category)) return 'expense'
  if (t.seedIncomeNames.includes(category)) return 'income'
  return null
}

/* ── C1 词条极性完整性（今天红：SYNONYMS 是 Record<string,string>）──────── */

export const checkSynonymPolarity: CriterionCheck = (t) =>
  t.synonyms
    .filter((s) => s.type == null)
    .map((s) => ({
      kind: 'synonym_polarity_missing' as const,
      term: s.key,
      where: WHERE_SYNONYMS,
      hint: '把该条目改成带 type 的极性桶条目（同一 key 可有多条、不同 type）；'
        + '极性不能靠「目标分类恰好在哪一桶」隐式决定',
    }))

/* ── C2 跨表极性一致（今天全绿：上一版判据对「红包」误报过一次）──────────
 * 判据：**同一个 (词, 极性) 在两张表里指向不同的目标分类 = 冲突**。
 *
 * 为什么不是「同一 (词, 极性) 只能被一张表认领」：那样「红包 / expense」会被
 * matcher 与 import-matcher 同时认领而误报——它们本来就是同一语义的两份拷贝，
 * 是**要互相对账**的关系，不是矛盾。
 *
 * 为什么上一版的「两张表对同一个词的极性声明不得互斥」是错的：
 * 它把 quick 的 `红包 → 红包/income` 与 matcher 的 `红包 → 人情/expense`
 * 判成冲突，但这两条**服务不同语境、永不同时生效**（quick 走用户手打短句、
 * matcher 走模型输出），「红包合法双极性」（设计 §3.5）也会被它一并判红。
 * 本判据只看**同一极性下目标是否一致**，与极性桶设计、语境分流都不冲突。
 *
 * 验算今天的状态（应全绿）：
 *   (红包, expense)：matcher→人情 · import→人情 → 一致
 *   (红包, income) ：matcher→— · quick→红包 · import→红包 → 一致
 */

type PolarDecl = { readonly where: string; readonly type: TxnType; readonly target: string }

function collectPolarities(t: CriterionTables): Map<string, PolarDecl[]> {
  const out = new Map<string, PolarDecl[]>()
  const push = (key: string, decl: PolarDecl): void => {
    out.set(key, [...(out.get(key) ?? []), decl])
  }
  for (const s of t.synonyms) {
    // 缺 type 的条目由 C1 报；这里用目标分类所在种子桶还原它今天的隐式极性，
    // 否则今天那条「红包」冲突（正是本次要抓的）根本报不出来。
    const type = s.type ?? seedBucketOf(s.category, t)
    if (type) push(s.key, { where: WHERE_SYNONYMS, type, target: s.category })
  }
  for (const q of t.quickConfidence) {
    if (q.type) push(q.key, { where: WHERE_QUICK, type: q.type, target: q.category })
  }
  for (const r of t.importRules) {
    for (const kw of r.keywords) {
      for (const type of r.types ?? []) push(kw, { where: WHERE_IMPORT, type, target: r.category })
    }
  }
  return out
}

/** 某张表对一个 (词, 极性) 的全部目标分类（去重、字典序，报告可复现） */
function targetsIn(decls: readonly PolarDecl[], where: string): string[] {
  return [...new Set(decls.filter((d) => d.where === where).map((d) => d.target))].sort()
}

/** 表名两两配对（顺序即报告顺序，确定性） */
function tablePairs(tables: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) out.push([tables[i]!, tables[j]!])
  }
  return out
}

/** 按极性分组（同 (词, 极性) 的所有声明） */
function groupByPolarity(decls: readonly PolarDecl[]): Map<TxnType, PolarDecl[]> {
  const out = new Map<TxnType, PolarDecl[]>()
  for (const d of decls) out.set(d.type, [...(out.get(d.type) ?? []), d])
  return out
}

function targetConflicts(key: string, type: TxnType, group: readonly PolarDecl[]): Conflict[] {
  const tables = [...new Set(group.map((d) => d.where))]
  const conflicts: Conflict[] = []
  for (const [a, b] of tablePairs(tables)) {
    const left = targetsIn(group, a)
    const right = targetsIn(group, b)
    if (left.some((x) => right.includes(x))) continue
    conflicts.push({
      kind: 'polarity_conflict',
      term: key,
      where: `${a} ↔ ${b}`,
      hint: `同一个词、同一个极性（${key} / ${type}）在两层判据里指向不同分类：`
        + `${a} → ${left.join('/')}，${b} → ${right.join('/')}；`
        + '同一极性下它们服务同一批输入、无法靠 type 区分，请统一目标分类名或删掉其中一条',
    })
  }
  return conflicts
}

export const checkPolarityConflict: CriterionCheck = (t) => {
  const conflicts: Conflict[] = []
  for (const [key, decls] of collectPolarities(t)) {
    for (const [type, group] of groupByPolarity(decls)) {
      conflicts.push(...targetConflicts(key, type, group))
    }
  }
  return conflicts
}

/* ── C3 同义词目标存在性（只对内置种子表断言，用户改名不参与）──────────── */

export const checkSynonymTarget: CriterionCheck = (t) => {
  const conflicts: Conflict[] = []
  for (const s of t.synonyms) {
    if (s.type == null) continue // C1 已报；无声明极性时无法判「同极性」
    if (seedNamesOf(s.type, t).includes(s.category)) continue
    conflicts.push({
      kind: 'synonym_target_missing',
      term: s.key,
      where: WHERE_SYNONYMS,
      hint: `目标分类「${s.category}」不在同极性（${s.type}）的种子分类表里；`
        + '词条已成死词（用户改名/删掉该分类后它会一路掉到兜底桶被悄悄兑现），请更新目标或删除该条目',
    })
  }
  return conflicts
}

/* ── C4 prompt 噪声例句必须被服务端判为噪声 ───────────────────────────── */

export const checkPromptExamples: CriterionCheck = (t) =>
  t.promptNoiseExamples
    .filter((e) => classifyNotification(e.text).tier !== 0)
    .map((e) => ({
      kind: 'prompt_example_not_noise' as const,
      term: e.id,
      where: WHERE_PROMPT,
      hint: `prompt 说「${e.text}」不是账，服务端分流却给出 tier ${classifyNotification(e.text).tier}；`
        + '两边语义矛盾，请改 prompt 文案或改服务端判据（不许只改一处）',
    }))

/* ── C5 噪声条目不得是裸词（裸词永不判噪声）───────────────────────────── */

export const checkNoiseTerms: CriterionCheck = (t) => {
  const bare = t.noiseTerms.filter((n) => n.context == null)
  const seedNames = [...t.seedExpenseNames, ...t.seedIncomeNames]
  const synonymKeys = t.synonyms.map((s) => s.key)
  const conflicts: Conflict[] = bare.map((n) => ({
    kind: 'noise_term_missing_context' as const,
    term: n.term,
    where: WHERE_NOISE,
    hint: '噪声条目缺必填 context = 裸词判噪声；裸词会与用户自建的同名分类正面冲突（误杀真账），必须给出语境正则',
  }))
  for (const n of bare) {
    if (seedNames.includes(n.term)) {
      conflicts.push({
        kind: 'noise_bare_term_matches_seed_category',
        term: n.term,
        where: WHERE_NOISE,
        hint: `「${n.term}」既是裸噪声词、又是内置分类名：用户手打它会被当噪声丢掉真账；请给它加 context`,
      })
    }
    if (synonymKeys.includes(n.term)) {
      conflicts.push({
        kind: 'noise_bare_term_matches_synonym',
        term: n.term,
        where: WHERE_NOISE,
        hint: `「${n.term}」既是裸噪声词、又是同义词键：噪声闸会抢在归类之前，用户自己说的这个词永远记不进来；请给它加 context`,
      })
    }
  }
  return conflicts
}

/* ── C6 rules.json ↔ 服务端：只禁「反向词」（客户端拦 / 服务端认）────────── */

export const checkClientVsServer: CriterionCheck = (t) => {
  const r = t.rules
  if (!r) return []
  const exempted = new Set(r.allowedOverlaps.map((o) => o.term))
  return r.clientBlockKeywords
    .filter((w) => !exempted.has(w.term))
    .filter((w) => r.serverPositiveTokens.some((p) => p.length >= 2 && (p === w.term || w.term.includes(p))))
    .map((w) => ({
      kind: 'client_block_vs_server_positive' as const,
      term: w.term,
      where: w.where,
      hint: `客户端无条件拦「${w.term}」、服务端把同一串当正向信号（金额/交易动词）：`
        + '客户端没有「正向信号优先」的保护，这条文本永远到不了服务端；'
        + '请收窄客户端词表，或把它写进显式豁免清单并附一句为什么无害',
    }))
}

/* ── C7 testcases 意图护栏：真交易一条都不许拦 ─────────────────────────── */

export const checkTestcases: CriterionCheck = (t) => {
  const r = t.rules
  if (!r) return []
  return r.testcases
    .filter((c) => c.expect_txn === true && c.expect_client !== 'pass')
    .map((c) => ({
      kind: 'testcase_missing_expect_client' as const,
      term: c.id,
      where: 'config/rules.json#testcases',
      hint: 'expect_txn=true（真交易）却没写 expect_client="pass"：'
        + '客户端 P0 断言「不可拦」没挂在这条语料上，请补上',
    }))
}

/** 全部判据，顺序即报告顺序 */
export const CRITERION_CHECKS: readonly CriterionCheck[] = [
  checkSynonymPolarity,
  checkPolarityConflict,
  checkSynonymTarget,
  checkPromptExamples,
  checkNoiseTerms,
  checkClientVsServer,
  checkTestcases,
  checkCrossTableWordConflict,
]