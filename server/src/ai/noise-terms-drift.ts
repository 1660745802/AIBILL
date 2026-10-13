/**
 * 防漂：`broadContext`（噪声表的审计用宽语境）vs `verify.ts` 的 `coupon_facevalue`
 *
 * 为什么要复制那份语境词、复制后怎么保证不漂，见下面 `couponContextTokens` 的注释。
 * 纯函数、无 IO；只在「验证副本是否还对得上真源」时被调用，**不参与任何判定**。
 */
import { STRONG_NOISE_RULES } from './verify.js'
import { NOISE_TERMS } from './noise-terms.js'

/**
 * 为什么要复制：verify 的 `coupon_facevalue` 是**一个 alternation 里混着两种角色**：
 *
 *     立减金
 *   | (?:(?:红包|券|京东卡|购物卡|礼品卡|卡券)[\s\S]{0,20}?(?:最高减|满减|…|点击参与)  ← 券名词 … 语境
 *   | (?:(?:最高减|满减|直减|恭喜|受邀|专属优惠|名额有限)[\s\S]{0,20}?(?:红包|券|…|礼品卡)) ← 语境 … 券名词
 *
 * 而这里要的是「**单词条 + 单语境**」（每个 NoiseTerm 各带一个 context），拆这个
 * alternation 需要解析中间态（哪一侧是名词、哪一侧是语境），没法当契约用 —— 所以复制
 * 语境词集合，并用下面的断言把副本钉在真源上。
 *
 * 抽词口径（`couponContextTokens`）：
 *   1. 按**顶层** `|` 拆分支，并把「整条被一个组包住」的分支拆开重跑
 *      （verify 那条是 `立减金 | (?:方向一|方向二)`，不拆这层切不出两侧）；
 *   2. 每个分支再按「间隔」`[\s\S]{n,m}?` 拆成两侧；
 *   3. 两侧角色靠**词表**判定：整侧都是券名词的那侧是名词侧，另一侧就是语境侧
 *      —— 这一步就是「一个 alternation 里混着两种角色」的处理方式；
 *   4. 只收「纯文字」的叶子：剥掉转义序列后仍残留正则元字符的整条丢弃。
 * 不符合以上形态的分支会被**显式丢弃**，宁可漏报也不猜 —— 漏报会让下面的断言报红。
 */

const COUPON_NOUNS: ReadonlySet<string> = new Set([
  '红包', '券', '京东卡', '购物卡', '礼品卡', '卡券', '立减金',
])

/** 名词 … 语境 / 语境 … 名词 之间那个「任意字符 N~M 次」的间隔 */
const GAP_SOURCE = String.raw`[\s\S]\{[^}]*\}\??`

/** 顶层交替：括号深度 0、字符类外的 `|` 才是分支界（括号里的 `|` 不拆） */
function splitTopLevelAlternation(pattern: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') { buf += ch + (pattern[i + 1] ?? ''); i += 1; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (!inClass && ch === '(') depth += 1
    else if (!inClass && ch === ')') depth -= 1
    if (ch === '|' && depth === 0 && !inClass) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 整条分支就是一个包裹组时，把组拆开重跑。
 * verify 那条正则是 `立减金 | (?: 方向一 | 方向二 )` —— 整组包着两个方向，
 * 不拆这一层就永远切不出「两侧」。
 */
function unwrapWholeGroup(branch: string): string | null {
  const t = branch.trim()
  if (!t.startsWith('(')) return null
  let depth = 0
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (ch === '\\') { i += 1; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i === t.length - 1 ? t.slice(t[1] === '?' ? 3 : 1, i) : null
    }
  }
  return null
}

function flattenAlternation(pattern: string): string[] {
  const out: string[] = []
  for (const branch of splitTopLevelAlternation(pattern)) {
    const inner = unwrapWholeGroup(branch)
    if (inner === null) out.push(branch)
    else out.push(...flattenAlternation(inner))
  }
  return out
}

/**
 * 把一段正则里的「纯文字片段」逐个抽出来（按元字符切段）。
 *
 * 导出是因为别处也要抽词：判据 C6 要把 `nls.payment_signal_regex` 与
 * `PAYMENT_VERB` 的字面量 token 取出来当「服务端正向判据」，
 * 抽词口径必须与这里一致（同一份实现 = 不会两端口径各写一套）。
 *
 * 为什么按「纯文字片段」而不是按 alternation 的叶子：`(?:(?:红包|券|卡券)` 这种**被
 * 切开的半个组**（间隔 split 后左右两侧都会缺一个右括号）没法再按叶子解析，
 * 按元字符切段则两种形态都拿得到同样的词表。
 * 含非「文字」字符的片段（`¥`、`\d`、`{0,20}` 之类）会被整段丢弃 → 宁可漏报也不猜。
 */
export function plainRuns(branch: string): string[] {
  const runs: string[] = []
  let buf = ''
  const flush = (): void => {
    if (buf.length > 0) runs.push(buf)
    buf = ''
  }
  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i]!
    if (ch === '\\') { i += 1; flush(); continue }
    if ('()[]{}|?*+^$'.includes(ch)) { flush(); continue }
    buf += ch
  }
  flush()
  return runs.filter((r) => /^[\p{Script=Han}A-Za-z0-9]+$/u.test(r))
}

function isNounSide(words: string[]): boolean {
  return words.length > 0 && words.every((w) => COUPON_NOUNS.has(w))
}

/**
 * 从 verify 的 `coupon_facevalue` 正则里抽出**语境词集合**（纯函数，无 IO）。
 * 只处理「名词 间隔 语境」与「语境 间隔 名词」两种形态，其余分支丢弃。
 */
export function couponContextTokens(couponPattern: string): string[] {
  const gap = new RegExp(GAP_SOURCE, 'g')
  const tokens = new Set<string>()
  for (const branch of flattenAlternation(couponPattern)) {
    const sides = branch.split(gap).filter((x) => x.length > 0)
    if (sides.length !== 2) continue // 单侧分支（整条就是一个名词，如「立减金」）不产出语境
    const left = plainRuns(sides[0]!)
    const right = plainRuns(sides[1]!)
    if (isNounSide(left)) right.forEach((w) => tokens.add(w))
    else if (isNounSide(right)) left.forEach((w) => tokens.add(w))
  }
  return [...tokens].sort()
}

/** verify 里那条券面额噪声规则的**当前**正则源码（live 引用，不是快照） */
export function couponFacevaluePattern(): string {
  const rule = STRONG_NOISE_RULES.find((r) => r.name === 'coupon_facevalue')
  if (!rule) throw new Error('verify 里找不到 coupon_facevalue 规则，防漂断言无从比对')
  return rule.pattern
}

/** 我们那份副本的源码：从第一个带 broadContext 的词条上取（保证测的就是真在用的那份） */
function defaultBroadContextSource(): string {
  const term = NOISE_TERMS.find((t) => t.broadContext)
  if (!term?.broadContext) throw new Error('NOISE_TERMS 里没有任何词条带 broadContext，防漂断言无从比对')
  return term.broadContext.source
}

/**
 * 防漂断言的输入：**两侧词集合的对称差**（空 = 完全一致）。
 * 用对称差而不是「包含」，这样 verify 加了词、这里没跟也会报（缺 + 多两个方向都查）。
 */
export function broadContextDrift(
  broadPattern: string = defaultBroadContextSource(),
  couponPattern: string = couponFacevaluePattern(),
): { missing: string[]; extra: string[] } {
  const mine = new Set(plainRuns(`(?:${broadPattern})`))
  const theirs = new Set(couponContextTokens(couponPattern))
  return {
    missing: [...theirs].filter((w) => !mine.has(w)).sort(),
    extra: [...mine].filter((w) => !theirs.has(w)).sort(),
  }
}
