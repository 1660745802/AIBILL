/**
 * 归类决策：模型给的分类名 → 用户真实存在的 category_id
 *
 * 这一层唯一的硬不变量（比任何一条启发式都强）：
 *   **返回的 category_id 若非 null，必 ∈ 用户该 type 的活跃分类 id 集合。**
 *   不编造 = 永远指向用户真实存在的分类，或者 null。
 *
 * 阶梯（自上而下，首条命中即终止）：
 *   L0 极性闸 → L1 噪声闸（词+语境坐实是广告 → 不给任何分类）→ L2 精确
 *      → L3 同义词整键 → L4 受约束包含 → L5 同义词扫描
 *      → L6「其他」桶（用户自己建的「归不了类就放这」的桶，不是编造）→ L7 留空
 *
 * 结果自描述：reason / reason_detail / is_exact / noise 全带出来，调用方不必再问第二次
 * （重写前要判「是不是精确命中」必须先跑旧 matchCategory 拿 name、再喂给内部硬编码
 * `matchedName === '其他'` 的 isExactCategoryMatch；两者已分别在 Step 1、Step 5 删除）。
 */

// 同义词表在 ai/synonyms.ts（数据表，不是判定逻辑；那边对本文件只有 type-only 引用，编译后抹掉，无运行时环）
import { SYNONYMS, type SynonymEntry } from './synonyms.js'
import { judgeNoise, type NoiseAudit, type NoiseVerdict } from './noise-terms.js'

export type { SynonymEntry }

/** 分类信息：调用方给，本模块不碰 DB */
export interface CategoryInfo {
  readonly id: number
  readonly name: string
  readonly type: 'expense' | 'income'
}

/** 交易类型（极性） */
export type CategoryType = CategoryInfo['type']

/** 归类理由：封闭枚举，可枚举、可审计、可跨端对齐；不允许自由字符串 */
export type CategoryReason =
  | 'exact'                  // 与用户某个**同类型**分类逐字相同
  | 'synonym_exact'          // 整键命中同义词表（极性一致 + 目标分类真实存在）
  | 'contains'               // 受约束的包含匹配（L4：唯一/最长 + 长度与方向门槛）
  | 'synonym_scan'           // 扫描同义词表命中（本步按插入顺序，Step 3 换长度降序）
  | 'noise_word'             // 词 + 语境命中噪声判据 → 不归类（**Step 4 才可达**）
  | 'other_fallback'         // 归入用户自己建的「其他」桶（**不是**编造）
  | 'undetermined'           // 走完阶梯仍无依据 → null
  | 'no_candidate'           // 该 type 一个活跃分类都没有 → null

/** 枚举自检护栏：reason 取值集合不得悄悄漂移（测试用 it.each 逐条覆盖） */
export const CATEGORY_REASONS: readonly CategoryReason[] = [
  'exact',
  'synonym_exact',
  'contains',
  'synonym_scan',
  'noise_word',
  'other_fallback',
  'undetermined',
  'no_candidate',
]

export interface CategoryResolution {
  readonly category_id: number | null
  /** 无则 ''——绝不回「其他」/「未分类」之类的假名 */
  readonly category_name: string
  /**
   * 本模块拿不到 icon（CategoryInfo 里没有），恒为 ''；
   * 调用方按 category_id 回查自己的行拿 icon。
   */
  readonly category_icon: string
  readonly reason: CategoryReason
  /** 人可读审计串：命中的词键 / 被拒候选 / 为何停 */
  readonly reason_detail: string
  /**
   * 是否「精确命中」。
   *
   * ⚠️ **比 `reason === 'exact'` 多一个例外：结果分类名为「其他」时恒 false。**
   * 这是从 isExactCategoryMatch 原样搬过来的语义（那里是硬编码
   * `if (matchedName === '其他') return false`），Step 1 必须保持等价；
   * 「其他」是兜底桶不是精确选择，所以 needs_review 仍为 true。
   */
  readonly is_exact: boolean
  /**
   * 噪声闸审计（Step 4 决策：「窄语境先不改，但判例要能被管理员复核」）：
   * `{source:'narrow', term}` = 被噪声闸判掉；`{source:'broad', term:null}` =
   * 窄语境放过但宽口径会判（人工复核对象）；`null` = 两口径一致（不给每笔塞噪音）。
   */
  readonly noise: NoiseAudit | null
}


/** 兜底桶名（「其他」是用户自己建的「归不了类就放这」的桶，不是编造） */
const OTHER_CATEGORY_NAME = '其他'

/* ══ 阶梯 ══════════════════════════════════════════════════════════════ */

export interface ResolveCategoryRequest {
  /** 模型/用户给的分类名（可空、可乱编） */
  readonly requested: string | null | undefined
  readonly type: CategoryType
  /** 该用户的活跃分类（调用方已按 user_id 过滤） */
  readonly categories: readonly CategoryInfo[]
  /**
   * 原文。噪声判定必须回原文取语境——**模型只会吐「红包」两个字，无从表达语境**。
   * 缺省时噪声闸退化为「只看裸词，裸词永不是噪声」（不误杀），
   * 并在 reason_detail 记 `evidence_missing`。
   */
  readonly evidenceText?: string
}

/** L0 短路：极性非法或该 type 无活跃分类 */
function noCandidate(reasonDetail: string): CategoryResolution {
  return emptyFields('no_candidate', reasonDetail)
}

/** 无解时的统一形状：三个字段全空，绝不填假名 */
function emptyFields(reason: CategoryReason, detail: string): CategoryResolution {
  return {
    category_id: null,
    category_name: '',
    category_icon: '',
    reason,
    reason_detail: detail,
    is_exact: false,
    noise: null,
  }
}

function hit(c: CategoryInfo, reason: CategoryReason, detail: string): CategoryResolution {
  return {
    category_id: c.id,
    category_name: c.name,
    category_icon: '',
    reason,
    reason_detail: detail,
    is_exact: reason === 'exact' && c.name !== OTHER_CATEGORY_NAME,
    noise: null,
  }
}

/* L1 噪声闸就写在 decide() 里（Step 4 接线）：**优先级高于 L2..L7**——
 * 语境坐实是广告/券面额/待领取时，任何分类名都不该赢，**包括用户自建的同名分类**；
 * 裸词永不判噪声（evidenceText 缺失 → judgeNoise 恒不判，见 noise-terms.ts）。 */

/** L2：精确同名（含用户自己写的「其他」——那是真实选择，不是兜底） */
function exactMatch(name: string, filtered: readonly CategoryInfo[]): CategoryResolution | null {
  const hits = filtered.filter((c) => c.name === name)
  const first = hits[0]
  if (!first) return null
  const dup = hits.length > 1 ? `（同名 ${hits.length} 个，取首个 id=${first.id}）` : ''
  return hit(first, 'exact', `exact:${name}${dup}`)
}

/** L3：同义词整键。极性不符 / 目标分类不存在 → **丢弃候选，不得改投** */
function synonymExact(
  name: string,
  type: CategoryType,
  filtered: readonly CategoryInfo[],
): CategoryResolution | null {
  const entry = SYNONYMS.find((e) => e.key === name && e.type === type)
  if (!entry) return null
  const target = filtered.find((c) => c.name === entry.category)
  if (!target) return null
  return hit(target, 'synonym_exact', `synonym_exact:${entry.key}→${entry.category}(${entry.type})`)
}

/** L4：受约束的包含匹配。三个门槛全满足才接受 */
function containsAccepted(name: string, c: CategoryInfo): boolean {
  const shorter = Math.min(name.length, c.name.length)
  if (shorter < 2) return false // 长度 1 一律不接受（L2 exact 已先处理）
  if (name.includes(c.name)) return true // 方向 A：模型给得更长
  // 方向 B：模型给得更短，需长度比 ≥ 0.5
  return name.length / c.name.length >= 0.5
}

/** 码位序（不用 localeCompare：它依赖运行时 ICU 完整度 → 赢家不可复现） */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** L4：多候选时取**最长**（等长取码位序首个），全部候选写进审计串 */
function containsMatch(name: string, filtered: readonly CategoryInfo[]): CategoryResolution | null {
  const related = filtered.filter((c) => name.includes(c.name) || c.name.includes(name))
  const accepted = related.filter((c) => containsAccepted(name, c))
  if (accepted.length === 0) return null
  const sorted = [...accepted].sort((a, b) => b.name.length - a.name.length || byCodepoint(a.name, b.name))
  const winner = sorted[0]!
  const listed = accepted.map((c) => `${c.name}(len=${c.name.length},id=${c.id})`).join('/')
  const tie = sorted[1]?.name.length === winner.name.length ? '(等长取码位序首个)' : ''
  return hit(winner, 'contains', `contains:${winner.name}${tie};candidates=${listed}`)
}

/**
 * L5：扫描同义词表。
 *
 * **排序规则（Step 3 定）：key 长度降序；等长按码位序升序。**
 * 重写前是「按词表声明顺序，第一个 name.includes(key) 命中即赢」——加一条新词
 * 就可能改变一笔账的归类，事后也无法反推为什么是它（设计 §0.3 C）。
 * 现在换成可写进审计串的确定性规则：更具体的词优先，等长用码位序而非书写顺序。
 */
function synonymScan(
  name: string,
  type: CategoryType,
  filtered: readonly CategoryInfo[],
): CategoryResolution | null {
  const candidates = SYNONYMS
    .filter((e) => name.includes(e.key) && e.type === type)
    .filter((e) => filtered.some((c) => c.name === e.category))
  if (candidates.length === 0) return null
  const ranked = [...candidates].sort((a, b) => b.key.length - a.key.length || byCodepoint(a.key, b.key))
  const winner = ranked[0]!
  const target = filtered.find((c) => c.name === winner.category)
  if (!target) return null
  // 审计串记三件事：命中哪个键、排序依据、以及**被拒的候选**（含它们各自的目标）
  const order = ranked.map((e) => `${e.key}→${e.category}`).join('>')
  return hit(
    target,
    'synonym_scan',
    `synonym_scan:${winner.key}→${winner.category};rule=key长度降序+等长码位序升序;ranked=${order}`,
  )
}

/**
 * L6「其他」桶：用户自己建的「归不了类就放这」——真实存在，不是编造。
 * ⚠️ 这里曾有第二级兜底「随便第一个分类」（categories[0]），Step 2 已删：
 * 没有「其他」桶时留空，不再替用户挑一个（种子表第一项是「餐饮」）。
 */
function otherBucket(filtered: readonly CategoryInfo[]): CategoryResolution | null {
  const other = filtered.find((c) => c.name === OTHER_CATEGORY_NAME)
  if (!other) return null
  return hit(other, 'other_fallback', `other_fallback:其他(id=${other.id})`)
}

/** 唯一的决策入口：一次调用返回自描述结果，调用方不必再问第二次（见文件头） */
export function resolveCategory(req: ResolveCategoryRequest): CategoryResolution {
  const name = (req.requested ?? '').trim()
  const base = decide(req, name)
  if (req.evidenceText !== undefined && req.evidenceText !== '') return base
  // 无原文：噪声闸恒不判（裸词永不判噪声），但要在审计串里看得见
  return { ...base, reason_detail: `${base.reason_detail}|evidence_missing` }
}

/** 窄语境没判、宽口径会判的判例也要记下来，否则「窄口径放过的那批」永远没人看 */
function noiseAuditOf(verdict: NoiseVerdict): NoiseAudit | null {
  if (verdict.hit) return { term: verdict.hit.term, source: 'narrow' }
  if (verdict.source === 'broad') return { term: null, source: 'broad' }
  return null
}

function decide(req: ResolveCategoryRequest, name: string): CategoryResolution {
  if (req.type !== 'expense' && req.type !== 'income') {
    return noCandidate(`no_candidate:invalid_type=${String(req.type)}`)
  }
  const filtered = req.categories.filter((c) => c.type === req.type)
  if (filtered.length === 0) {
    return noCandidate(`no_candidate:type=${req.type},该 type 活跃分类数=0`)
  }
  const verdict = judgeNoise(name, req.evidenceText)
  const audit = noiseAuditOf(verdict)
  if (verdict.hit) {
    const detail = `noise_word:${verdict.hit.term}(${verdict.hit.reason});`
      + '词 + 语境同时命中 → 不给任何分类（含用户自建的同名分类）'
    return { ...emptyFields('noise_word', detail), noise: audit }
  }
  return { ...ladder(name, req.type, filtered), noise: audit }
}

/** L2..L7：噪声闸之后的全部阶梯 */
function ladder(name: string, type: CategoryType, filtered: readonly CategoryInfo[]): CategoryResolution {
  const byName = exactMatch(name, filtered)
  if (byName) return byName
  const synonym = synonymExact(name, type, filtered)
  if (synonym) return synonym
  const contains = containsMatch(name, filtered)
  if (contains) return contains
  const scan = synonymScan(name, type, filtered)
  if (scan) return scan
  const bucket = otherBucket(filtered)
  if (bucket) return bucket
  return emptyFields('undetermined', undeterminedDetail(name, filtered))
}

/** L7 留空：说清「请求的是什么、候选有哪些、为何都没接受」，供审计/回归定位 */
function undeterminedDetail(name: string, filtered: readonly CategoryInfo[]): string {
  const candidates = filtered.map((c) => c.name).join('/')
  return `undetermined:requested=${name};candidates=[${candidates}];`
    + '无同名/同义词/包含匹配，且该 type 没有「其他」桶 → 留空，不替用户挑一个分类'
}
