/**
 * 判据 C8：同义词表 ↔ import-matcher 的交叉一致性（纯函数、零行为变更）
 *
 * 为什么单独成文件：C8 自带一套「词 → 极性 → 目标」的数据收集与比较逻辑，
 * 放回 criterion-checks.ts 会把那个文件顶过 ARCHITECTURE §4.2 的 300 行上限
 * （它是 C1..C8 九条判据的合集）。判据集合仍由 criterion-checks.ts 组装。
 *
 * ⚠️ 这里只 import **类型**（`import type` 编译后即被抹掉），运行时不会与入口成环。
 */
import type {
  Conflict,
  CriterionTables,
  CriterionCheck,
  TxnType,
} from './criterion-consistency.js'
import { WHERE_SYNONYMS, WHERE_IMPORT } from './criterion-where.js'

/** 两个极性（用于「不限极性」展开与遍历顺序） */
const ALL_TYPES: readonly TxnType[] = ['expense', 'income']

/* ── C8 同义词表 ↔ import-matcher 的交叉一致性 ──────────────────────────
 * 事实：`ai/synonyms.ts` 的 SYNONYMS 与 `lib/import-matcher.ts` 的 CATEGORY_RULES
 * 是两份**独立维护**的「词 → 分类」数据，分别服务模型输出与 CSV 导入两条链路。
 * 各自都能跑、都不报错，但改了其中一份另一份不知道，于是同一条描述在两条链路上
 * 会被归到两个不同分类，而**没有任何测试会发现它**。
 *
 * 判据（两步，以 import 侧为准——它显式写了 types）：
 *   ① 同一 (词, 极性) 两边都声明了目标，而目标集合不相等 → 冲突
 *   ② SYNONYMS 没在该 (词, 极性) 声明、只在**另一极性**声明了同一个词，
 *      且那边指向的目标与 import 不同 → 也算冲突
 *      （同一个词在两份表里落进不同分类，与极性怎么编码无关；这也是今天
 *        ('红包','income') 的真实形状：SYNONYMS 只声明 (红包,expense)→人情，
 *        import 声明 (红包,income)→红包。Step 3 把 SYNONYMS 拆成极性桶后转绿）
 *
 * 极性口径：SYNONYMS 用 entry.type；CATEGORY_RULES 的 types 缺省表示**不限**，
 * 不限时该条对两个极性都算声明（它是「商户描述关键词 → 分类」的无条件规则）。
 *
 * 今天实测：同极性重叠 45 条全一致，跨极性单向声明 40 条里只有 1 条目标不同
 *   ('红包', 'income')：SYNONYMS 说「人情」· CATEGORY_RULES 说「红包」
 * 根因是 SYNONYMS 的极性由 INCOME_SYNONYM_TARGETS 派生，红包不在里面，
 * income 的红包被推成了 expense。
 * （tests/ai/criterion-consistency.test.ts 里有 characterization 锁钉住这 1 条）
 */

/** 词 → 极性 → 目标分类集合 */
type PolarTargets = Map<string, Map<TxnType, Set<string>>>

function declareTarget(out: PolarTargets, word: string, type: TxnType, target: string): void {
  const byPolarity = out.get(word) ?? new Map<TxnType, Set<string>>()
  const targets = byPolarity.get(type) ?? new Set<string>()
  targets.add(target)
  byPolarity.set(type, targets)
  out.set(word, byPolarity)
}

function collectSynonymTargets(t: CriterionTables): PolarTargets {
  const out: PolarTargets = new Map()
  for (const s of t.synonyms) {
    if (s.type == null) continue // C1 已报；没有声明极性就无从比
    declareTarget(out, s.key, s.type, s.category)
  }
  return out
}

function collectImportTargets(t: CriterionTables): PolarTargets {
  const out: PolarTargets = new Map()
  for (const r of t.importRules) {
    for (const type of r.types ?? ALL_TYPES) {
      for (const kw of r.keywords) declareTarget(out, kw, type, r.category)
    }
  }
  return out
}

/** 排好序的目标列表（比较与报告都可复现） */
function sortedTargets(byPolarity: Map<TxnType, Set<string>> | undefined, type: TxnType): string[] {
  return [...(byPolarity?.get(type) ?? [])].sort()
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** 某词在哪张表里的声明；找不到时返回 null（与「声明了空集」区分开） */
function declarationOf(table: PolarTargets, word: string, type: TxnType): string[] | null {
  const list = sortedTargets(table.get(word), type)
  return list.length === 0 ? null : list
}

/** SYNONYMS 只在另一个极性声明这个词时，返回那边的目标（附极性） */
function otherPolarityDeclaration(
  table: PolarTargets,
  word: string,
  type: TxnType,
): { type: TxnType; targets: string[] } | null {
  for (const other of ALL_TYPES) {
    if (other === type) continue
    const targets = sortedTargets(table.get(word), other)
    if (targets.length > 0) return { type: other, targets }
  }
  return null
}

function crossTableConflict(
  word: string,
  type: TxnType,
  importTargets: string[],
  synTargets: string[],
  synDeclaredAt: string,
): Conflict {
  return {
    kind: 'cross_table_word_conflict',
    term: word,
    polarity: type,
    where: `${WHERE_SYNONYMS} ↔ ${WHERE_IMPORT}`,
    hint: `同一个 (词, 极性) = (${word}, ${type}) 在两份「词 → 分类」表里指向不同目标：`
      + `${WHERE_SYNONYMS} 说 ${synTargets.join('/')}（声明于 ${synDeclaredAt}），`
      + `${WHERE_IMPORT} 说 ${importTargets.join('/')}；`
      + '两份表各写各的，改一边不会影响另一边，也没有任何测试会发现；'
      + '请统一目标分类名（收到的红包该指向收入分类「红包」），或补上对应的极性桶条目',
  }
}

export const checkCrossTableWordConflict: CriterionCheck = (t) => {
  const synonymSide = collectSynonymTargets(t)
  const importSide = collectImportTargets(t)
  const conflicts: Conflict[] = []
  for (const [word, byPolarity] of importSide) {
    for (const [type, targets] of byPolarity) {
      const importTargets = [...targets].sort()
      const same = declarationOf(synonymSide, word, type)
      if (same) {
        if (sameTargets(same, importTargets)) continue
        conflicts.push(crossTableConflict(word, type, importTargets, same, `${type}`))
        continue
      }
      const other = otherPolarityDeclaration(synonymSide, word, type)
      if (!other || sameTargets(other.targets, importTargets)) continue
      conflicts.push(crossTableConflict(word, type, importTargets, other.targets, `${other.type}`))
    }
  }
  return conflicts
}
