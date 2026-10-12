/**
 * 通知规则真源（发布/真源规则见 docs/ARCHITECTURE.md §3.7）
 *
 * 内容真源 = 仓库文件 `server/config/rules.json`（进 git）；
 * DB `notification_rules` = 发布载体（历史 + 审计 + 拉取）。
 *
 * 启动流程（幂等）：load → validate → testcases 自检 → 内容 hash →
 * 与激活版本的 `content_hash` 比对：不同则发新版本并激活，相同则不动。
 * 任何一步失败一律 **fail-fast**——宁可起不来，也不要带着坏规则启动。
 *
 * 本模块是纯逻辑（不碰 HTTP），可单测。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { getDb } from '../db/index.js'
import { classifyNotification } from '../ai/verify.js'
import { derivePrecheck, type Precheck } from './precheck.js'

type Db = ReturnType<typeof getDb>

/** testcases 形状（见本文件 `validateRules` 里 `RuleTestcase` 的校验）：真护栏语料，不进下发 payload、不进 content hash */
export interface RuleTestcase {
  id: string
  note?: string
  channel?: string
  text: string
  expect_tier: number
  /** 服务端专属：期望的 `classifyNotification` 理由名（可选） */
  expect_reason?: string
  /** 夹具意图标记：true = 真交易（客户端 P0 断言「不可拦」挂在它上面） */
  expect_txn: boolean
  /** 只允许 `pass`（客户端不可拦）或缺省（不断言）；服务端 reason 请写 `expect_reason` */
  expect_client?: string
  tags?: string[]
}

/** rules.json 顶层形状（未知键由 validateRules 拒绝，这里只声明已知键） */
export interface RulesFile {
  nls?: Record<string, unknown> & { payment_signal_regex?: string }
  a11y?: Record<string, unknown>
  sms?: Record<string, unknown>
  source_mapping?: Record<string, string>
  processor?: Record<string, unknown>
  testcases?: RuleTestcase[]
  [k: string]: unknown
}

/** 顶层键白名单：未知键必须报错，不静默剥离（发布/回滚见 docs/ARCHITECTURE.md §3.7） */
const ALLOWED_TOP_LEVEL_KEYS: readonly string[] = [
  'nls',
  'a11y',
  'sms',
  'source_mapping',
  'processor',
  'testcases',
]

/** 内联 flags：`(?i)` `(?-i)` `(?im)` …（命名组是 `(?<`，不会命中） */
const INLINE_FLAGS = /\(\?[a-z-]+\)/
/** possessive 量词：`++` `*+` `?+` `{n,}+` */
const POSSESSIVE = /(?:[*+?]|\{\d+(?:,\d*)?\})\+/

/**
 * 读 + JSON.parse 规则文件。缺失 / 损坏一律抛错（fail-fast）。
 */
export function loadRulesFile(path: string): RulesFile {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`读取规则文件失败：${path}（${(err as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`解析规则文件失败：${path}（${(err as Error).message}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`解析规则文件失败：${path}（顶层必须是 JSON 对象）`)
  }
  return parsed as RulesFile
}


/**
 * lookaround 体是否为「有界」（单个字符类 / 单个转义 / 单个字符）。
 *
 * Java 要求 lookbehind 定长，而 `(?<![\d.])` 这种单字符类是定长的，两端都支持；
 * `(?<=a+)` / `(?<=ab?)` 这种变长在 JVM 上直接编译失败 → 必须拦。
 * 我们不追求完整解析正则，只做“足够保守”的判断：体里出现量词/分组/交替就算变长。
 */
function isBoundedLookaroundBody(body: string): boolean {
  if (/[*+?{]|\||\(/.test(body)) return false
  // 单个字符类 `[\d.]`、单个转义 `\d`、单个字符
  return /^(?:\[[^\]]*\]|\\[dswbDSWB]|.)$/.test(body)
}

/** 提取所有 lookaround（`(?<=...)` / `(?<!...)` / `(?=...)` / `(?!...)`）的体 */
function lookaroundBodies(pattern: string): string[] {
  const bodies: string[] = []
  const re = /\(\?[<][=!]|\(\?[=!]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pattern)) !== null) {
    let depth = 1
    let i = re.lastIndex
    let body = ''
    for (; i < pattern.length && depth > 0; i++) {
      const ch = pattern[i]
      if (ch === '\\') { body += ch + (pattern[i + 1] ?? ''); i++; continue }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) break }
      body += ch
    }
    bodies.push(body)
    re.lastIndex = i
  }
  return bodies
}

/**
 * 下发载荷的**必需形状**（路径 + 类型）。
 *
 * 为什么要把这个写成显式清单，而不是继续「看着像正则就查一查」：
 * 客户端是拿这份 payload 在**发请求前**做判据的，缺一个键就是运行时 NPE；
 * 而客户端自己的降级护栏（只守「首启未拉到」的窗口）并不该承担「服务端发了一份残规则」
 * 这种场景。服务端**发布时就 fail-fast** 成本最低，也最靠近真源。
 *
 * 同时把正则校验从「键名含 regex」的启发式换成**清单驱动**（`kind: 'regex'`）：
 * 否则谁新加一个 `a11y.exclude_pattern`，它就静静地不被安全子集校验了。
 * 原有的启发式降级为测试侧的**审计**（见 tests/lib/notification-rules.test.ts：
 * 文件里任何键名含 regex 的项都必须在清单里）。
 */
export interface RulesShapeSpec {
  path: string
  kind: 'string' | 'string[]' | 'number' | 'positiveInt' | 'regex' | 'stringRecord'
}

export const REQUIRED_RULES_SHAPE: readonly RulesShapeSpec[] = [
  { path: 'nls.payment_signal_regex', kind: 'regex' },
  { path: 'nls.wechat.package_name', kind: 'string' },
  { path: 'nls.wechat.direct_pass_titles', kind: 'string[]' },
  { path: 'nls.wechat.direct_pass_title_contains', kind: 'string[]' },
  { path: 'nls.wechat.message_prefixes', kind: 'string[]' },
  { path: 'nls.wechat.amount_symbols', kind: 'string[]' },
  { path: 'nls.alipay.package_name', kind: 'string' },
  { path: 'nls.alipay.allowed_title_keywords', kind: 'string[]' },
  { path: 'nls.bank_package_patterns', kind: 'string[]' },
  { path: 'nls.sms_packages', kind: 'string[]' },
  { path: 'a11y.embedded_payment_apps', kind: 'string[]' },
  { path: 'a11y.success_keywords', kind: 'string[]' },
  { path: 'a11y.embedded_success_keywords', kind: 'string[]' },
  { path: 'a11y.common_exclude_keywords', kind: 'string[]' },
  { path: 'a11y.wechat_alipay_exclude_keywords', kind: 'string[]' },
  { path: 'a11y.amount_regex', kind: 'regex' },
  { path: 'a11y.cooldown_minutes', kind: 'positiveInt' },
  { path: 'sms.spam_keywords', kind: 'string[]' },
  { path: 'source_mapping', kind: 'stringRecord' },
  { path: 'processor.scoring_window_seconds', kind: 'positiveInt' },
  { path: 'processor.dedup_window_seconds', kind: 'positiveInt' },
  { path: 'processor.marketing_suffix_cutoffs', kind: 'string[]' },
  { path: 'processor.max_amount_cents', kind: 'positiveInt' },
  { path: 'processor.min_amount_cents', kind: 'positiveInt' },
]

/** 按 `a.b.c` 取值（任一层不是对象 → undefined） */
function pickPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 校验必需形状（缺键 / 类型不符 / 空数组 / 空字符串一律报错） */
function validateRequiredShape(rules: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const spec of REQUIRED_RULES_SHAPE) {
    const v = pickPath(rules, spec.path)
    if (v === undefined) {
      errors.push(`缺少必需键：${spec.path}（客户端运行时需要，缺了会崩）`)
      continue
    }
    const nonEmptyStr = (x: unknown): boolean => typeof x === 'string' && x.trim().length > 0
    switch (spec.kind) {
      case 'string':
      case 'regex':
        if (!nonEmptyStr(v)) errors.push(`${spec.path} 必须是非空字符串`)
        break
      case 'string[]':
        if (!Array.isArray(v) || v.length === 0 || !v.every(nonEmptyStr)) {
          errors.push(`${spec.path} 必须是非空字符串数组`)
        }
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${spec.path} 必须是数字`)
        break
      case 'positiveInt':
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          errors.push(`${spec.path} 必须是正整数`)
        }
        break
      case 'stringRecord':
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`${spec.path} 必须是对象`)
        } else if (!Object.entries(v as Record<string, unknown>).every(([k, val]) => nonEmptyStr(k) && nonEmptyStr(val))) {
          errors.push(`${spec.path} 的键/值都必须是非空字符串`)
        }
        break
    }
  }
  // max ≥ min（跨字段约束，不能靠单条 spec 表达）
  const max = pickPath(rules, 'processor.max_amount_cents')
  const min = pickPath(rules, 'processor.min_amount_cents')
  if (typeof max === 'number' && typeof min === 'number' && max < min) {
    errors.push('processor.max_amount_cents 不能小于 min_amount_cents')
  }
  return errors
}

/**
 * **可选**键的形状校验：不强制存在（客户端有内置兜底），但一旦出现就必须是对的。
 *
 * 为什么单独一份：`REQUIRED_RULES_SHAPE` 是「缺了就崩」的键；这些是「有则生效」的调参键
 * （如客户端 A11Y 列表页门禁的词表与阈值）。把类型写错会安静地把云控变成"发了一份坏参数"，
 * 所以出现即校验。
 */
const OPTIONAL_RULES_SHAPE: readonly RulesShapeSpec[] = [
  { path: 'a11y.list_page_keywords', kind: 'string[]' },
  { path: 'a11y.list_page_min_amounts', kind: 'positiveInt' },
]

function validateOptionalShape(rules: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const spec of OPTIONAL_RULES_SHAPE) {
    const v = pickPath(rules, spec.path)
    if (v === undefined) continue // 可选：缺失 = 客户端用内置默认
    if (spec.kind === 'string[]') {
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.trim().length > 0)) {
        errors.push(`${spec.path} 若出现必须是非空字符串数组`)
      }
    } else if (spec.kind === 'positiveInt') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
        errors.push(`${spec.path} 若出现必须是正整数`)
      }
    }
  }
  return errors
}

/** 清单里的正则路径（正则安全子集按它校验，不再靠键名猜） */
export function regexPaths(): string[] {
  return REQUIRED_RULES_SHAPE.filter((s) => s.kind === 'regex').map((s) => s.path)
}

/**
 * 正则安全子集：返回错误描述；null = 通过。
 *
 * 允许 **有界 lookaround**（单字符类，如 `(?<![\d.])`）——服务端自己的判据就在用，
 * 而且 Java 的定长 lookbehind 能表达它；**变长 lookbehind**（`(?<=a+)`）在 JVM 上编译不过，
 * 所以依然拒绝。命名组 / `\p{}` / possessive / 内联 flags 一律不允许。
 */
function regexSafetyError(pattern: string): string | null {
  if (/\(\?<[A-Za-z_]/.test(pattern)) return '不允许命名捕获组'
  if (pattern.includes('\\p{') || pattern.includes('\\P{')) return '不允许 Unicode 属性转义'
  if (POSSESSIVE.test(pattern)) return '不允许 possessive 量词'
  /* 禁裸 `\s`/`\S`：JS 的 `\s` 是 Unicode 空白（含 U+3000/U+00A0），Java/Kotlin 默认只有 ASCII
     → 同一 pattern 两端判决分叉（真实事故：`RMB　100`、`100　元` 服务端算金额、客户端不算）。
     整字符用 `[\s\S]`（两语言下都等于「任意字符」）；要空白请显式列出字符类。 */
  // 先剥掉可移植的「任意字符」惯用法 [\s\S]（它两端语义一致；注意这里是字面量 `[`+反斜杠+s，
  // 写成 /\[\s\S\]/ 会变成「方括号里一个空白一个非空白」——那匹配不到实际 pattern 文本）
  const withoutAnyChar = pattern.replace(/\[\\s\\S\]/g, '').replace(/\[\\S\\s\]/g, '')
  /* 已知的**保守误拒**（复核 N9，可承受）：正则里写 `\\s`（字面量反斜杠 + s，两端语义一致）也会被判成
     裸 `\s`；未闭合的 `[\s\S` 报的是本错而非「无法编译」。当前真源不含这两种写法，故只记录不改。 */
  if (/\\[sS]/.test(withoutAnyChar)) {
    return '不允许 \\s/\\S（JS 与 Java 语义不同：JS 含 U+3000/U+00A0，Java 只有 ASCII）；整字符用 [\\s\\S]，空白请显式写字符类'
  }
  if (INLINE_FLAGS.test(pattern)) return '不允许内联 flags'
  for (const body of lookaroundBodies(pattern)) {
    if (!isBoundedLookaroundBody(body)) {
      return `不允许变长 lookaround（Java 要求 lookbehind 定长）：(?<...${body}...)`
    }
  }
  try {
    new RegExp(pattern)
  } catch (err) {
    return `无法编译：${(err as Error).message}`
  }
  return null
}

/**
 * 校验规则文件。返回错误列表，**空数组 = 通过**。
 *
 * ① 顶层键白名单严格（未知键报错，不静默剥离；缺键允许）
 * ② 正则安全子集（清单驱动：有界 lookaround 允许；变长 lookbehind / 命名组 / `\p{}` / possessive / 内联 flags 拒绝）
 * ③ 必需形状（`REQUIRED_RULES_SHAPE` 逐条查：缺键/类型错/空数组/空串报错，含 max≥min）
 * ④ `testcases[i]` 的 tier ∈ 0..4、text/id 非空、`expect_txn` 必填、`expect_client` 只允许 pass
 *
 * ⚠️ 顶层严格、**嵌套允许附加键**：客户端忽略未知键（契约 §7），所以多一个嵌套键无害；
 * 但**必需键**少一个就是客户端运行时 NPE，所以由 ③ 卡住。
 */
export function validateRules(rules: unknown): string[] {
  const errors: string[] = []
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    return ['规则顶层必须是 JSON 对象']
  }
  const obj = rules as Record<string, unknown>

  // ① 顶层键白名单严格
  for (const key of Object.keys(obj)) {
    if (key === 'precheck') {
      errors.push(
        'precheck 由代码派生（src/lib/precheck.ts，真源是 ai/verify.ts），不得写在规则文件里（防手抄漂移）',
      )
      continue
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.includes(key)) errors.push(`未知顶层键：${key}`)
  }

  // ② 正则安全子集（**清单驱动**，不再靠键名含 regex 的启发式；
  //    启发式降级为测试侧审计，见 tests/lib/notification-rules.test.ts）
  for (const path of regexPaths()) {
    const v = pickPath(obj, path)
    if (typeof v !== 'string' || v.length === 0) continue // 缺键/类型错由 ③ 报，这里不重复
    const e = regexSafetyError(v)
    if (e) errors.push(`${path}: ${e}`)
  }

  // ③ 必需形状（显式清单：客户端运行时需要的键，缺了会 NPE → 发布前 fail-fast）
  errors.push(...validateRequiredShape(obj))
  // ③' 可选形状（有则类型必须对；缺失由客户端兜底）
  errors.push(...validateOptionalShape(obj))

  // ④ testcases（可选；出现则逐条校验）
  const tcs = obj.testcases
  if (tcs !== undefined) {
    if (!Array.isArray(tcs)) {
      errors.push('testcases 必须是数组')
    } else {
      tcs.forEach((tc, i) => {
        if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) {
          errors.push(`testcases[${i}] 必须是对象`)
          return
        }
        const t = tc as Record<string, unknown>
        if (typeof t.id !== 'string' || t.id.length === 0) {
          errors.push(`testcases[${i}].id 必须是非空字符串`)
        }
        if (typeof t.text !== 'string' || t.text.length === 0) {
          errors.push(`testcases[${i}].text 必须是非空字符串`)
        }
        if (
          typeof t.expect_tier !== 'number' ||
          !Number.isInteger(t.expect_tier) ||
          t.expect_tier < 0 ||
          t.expect_tier > 4
        ) {
          errors.push(`testcases[${i}].expect_tier 必须是 0..4 的整数`)
        }
        /* `expect_client` 只允许 `pass`（客户端**不可拦**）或缺省（不断言）。
           曾经写过 `block:<服务端 reason>`——那是**假映射**：客户端预筛是另一套分类学
           （自身通知/去重/熔断/日报），拿服务端 reason 当客户端断言等于凭空造第三种口径。
           服务端自己的 reason 请写 `expect_reason`。 */
        if (t.expect_client !== undefined && t.expect_client !== 'pass') {
          errors.push(
            `testcases[${i}].expect_client 只允许 'pass' 或缺省（服务端 reason 请写 expect_reason）`,
          )
        }
        /* `expect_txn` 是**夹具层的意图标记**，不是分类结果：它区分「真交易」与
           「非交易文本（待付款页/购物车按钮/余额页）」。客户端 P0 断言（真交易一条都不许拦）
           必须挂在它上面——不能拿 `expect_tier∈{1,2,3}` 当代理，因为余额页这类
           非交易文本也会落 tier1。 */
        if (typeof t.expect_txn !== 'boolean') {
          errors.push(`testcases[${i}].expect_txn 必须是 boolean（夹具意图标记）`)
        }
      })
    }
  }

  return errors
}

/** 剔除 `testcases`：下发 payload 与 content hash 都不含语料（其形状由 `validateRules` 约束） */
export function stripTestcases(rules: RulesFile): RulesFile {
  if (rules === null || typeof rules !== 'object') return {}
  const { testcases: _drop, ...rest } = rules
  return rest as RulesFile
}

/** keys 排序后的 canonical JSON（数组保持顺序） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

/**
 * 内容 hash：sha256(先删 testcases，再对 keys 排序后的 canonical JSON)，返回 hex。
 *
 * 关键：testcases **不参与** hash——否则改一条用例就会让全体客户端重拉。
 */
export function contentHash(rules: RulesFile): string {
  return createHash('sha256').update(stableStringify(stripTestcases(rules))).digest('hex')
}

/**
 * 测试语料（`testcases`）的指纹，供客户端检测「自己 vendor 的副本是否漂移」。
 *
 * 为什么不把它塞进下发 payload：语料变更不应换 `content_hash`（否则改一条用例
 * 就会让全体客户端重拉）。所以两边各自持有副本、用这个值对齐——客户端实现要点：
 * 递归按键名排序、无空白 JSON、再 sha256；只含字符串/整数/数组，无浮点格式歧义。
 */
export function corpusHash(testcases: RuleTestcase[] | undefined): string {
  return createHash('sha256').update(stableStringify(testcases ?? [])).digest('hex')
}

/**
 * 发布载荷 = 文件（剔除 `testcases`） + **代码派生的 `precheck`**。
 *
 * `testcases` 不进载荷（改一条用例不该换 hash 让全体重拉）；`precheck` 反过来
 * **必须进载荷**（它是客户端要跑的那套判据，改了它就必须让客户端重拉）。
 */
export function buildPublishPayload(rules: RulesFile): RulesFile {
  const payload = { ...stripTestcases(rules), precheck: derivePrecheck() } as Record<string, unknown> & {
    precheck?: Precheck
  }

  /* ⚠️ **这里必须自己校验一遍**（复核 N8）：`regexSafetyError` 只在 `validateRules`（**文件级**）里跑，
     而 `precheck` 是**代码派生、注入到载荷**的——它的 pattern 从不经过文件校验。
     此前只有一条单测（`tests/lib/precheck.test.ts` 的「自己先过安全子集」）在守它：
     测试一旦被删/跳过，裸 `\s` 这类跨语言分歧（JS 含 U+3000/U+00A0、Java 只有 ASCII）
     会**无声回到下发判据** —— 那正是本轮修掉的 bug。所以把校验放到两条发布路径都必经的地方。 */
  const pre = payload.precheck
  if (pre) {
    const bad: string[] = []
    const check = (label: string, pattern: unknown, flags: unknown): void => {
      if (typeof pattern !== 'string' || pattern.length === 0) return
      const err = regexSafetyError(pattern)
      if (err) bad.push(`${label}（flags=${String(flags ?? '')}）：${err}`)
    }
    for (const r of pre.rules) check(r.id, r.pattern, r.flags)
    for (const [name, sig] of Object.entries(pre.signals)) {
      if (sig && typeof sig === 'object') {
        const s = sig as { pattern?: unknown; flags?: unknown }
        check(`signals.${name}`, s.pattern, s.flags)
      }
    }
    if (bad.length > 0) {
      throw new Error(`precheck 判据未通过安全子集（不得下发）：\n- ${bad.join('\n- ')}`)
    }
  }

  return payload
}

/** 发布载荷的 hash（ETag 与 `notification_rules.content_hash` 都用它） */
export function payloadHash(payload: RulesFile): string {
  return createHash('sha256').update(stableStringify(stripTestcases(payload))).digest('hex')
}

/**
 * testcases 自检（本侧真护栏）：逐条断言 `classifyNotification(text).tier === expect_tier`，
 * 并在给了 `expect_reason` 时同时断言理由名（不只看档位）。
 * 不一致 → 打印 case id 与实际值并抛错（启动即失败，不得带着坏规则跑）。
 */
export function selfTestTestcases(rules: RulesFile, testcases?: RuleTestcase[]): void {
  const list = testcases ?? rules.testcases ?? []
  for (const tc of list) {
    const c = classifyNotification(tc.text)
    if (c.tier !== tc.expect_tier) {
      const msg =
        `规则 testcases 自检失败：case ${tc.id} 期望 tier=${tc.expect_tier} ` +
        `实际 tier=${c.tier}（text=${JSON.stringify(tc.text)}）`
      console.error(`[notification-rules] ${msg}`)
      throw new Error(msg)
    }
    if (tc.expect_reason && !c.reasons.includes(tc.expect_reason)) {
      const msg =
        `规则 testcases 自检失败：case ${tc.id} 期望 reason=${tc.expect_reason} ` +
        `实际 reasons=${JSON.stringify(c.reasons)}`
      console.error(`[notification-rules] ${msg}`)
      throw new Error(msg)
    }
  }
}

export interface PublishResult {
  /** true = 发了新版本并激活；false = 内容未变（幂等 no-op） */
  published: boolean
  version: number
  content_hash: string
}

/**
 * 从文件发布规则：load → validate → selfTest → hash → 与激活版本比对。
 *
 * 校验失败 → 抛错（fail-fast）。内容相同 → no-op（幂等）。
 * `content_hash` 有 UNIQUE 约束：同一份内容已作为（非激活）历史版本存在时复用它，不新插。
 */
export function publishRulesFromFile(db: Db, path: string): PublishResult {
  const rules = loadRulesFile(path)
  const errors = validateRules(rules)
  if (errors.length > 0) {
    throw new Error(`规则文件校验失败（${path}）：\n- ${errors.join('\n- ')}`)
  }
  selfTestTestcases(rules)
  /* 发布载荷 = 文件（剔除 testcases） + **代码派生的 precheck**。
     在发布时注入而不是让文件里写：判据的唯一真源是 `ai/verify.ts` 的常量，
     文件里抄一份就会漂移；且 hash 覆盖 precheck → 代码改判据也会换 hash、客户端会重拉。 */
  const payload = buildPublishPayload(rules)
  const hash = payloadHash(payload)
  const serialized = JSON.stringify(payload)

  const active = db
    .prepare(
      'SELECT id, version, content_hash, rules FROM notification_rules WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
    )
    .get() as { id: number; version: number; content_hash: string | null; rules: string } | undefined

  if (active) {
    // 老库（migration020 之前）激活行没有 content_hash：用存量 rules 现算，
    // 避免「内容其实没变、只因为列是 NULL 就多发一个版本」。
    const activeHash = active.content_hash ?? payloadHash(JSON.parse(active.rules))
    if (activeHash === hash) {
      if (active.content_hash === null) {
        db.prepare('UPDATE notification_rules SET content_hash = ? WHERE id = ?').run(hash, active.id)
      }
      return { published: false, version: active.version, content_hash: hash }
    }
  }

  const sameContent = db
    .prepare('SELECT id, version FROM notification_rules WHERE content_hash = ? LIMIT 1')
    .get(hash) as { id: number; version: number } | undefined
  if (sameContent) {
    if (!active || active.id !== sameContent.id) {
      db.transaction(() => {
        db.prepare('UPDATE notification_rules SET is_active = 0 WHERE is_active = 1').run()
        db.prepare('UPDATE notification_rules SET is_active = 1 WHERE id = ?').run(sameContent.id)
      })()
    }
    return { published: false, version: sameContent.version, content_hash: hash }
  }

  const maxRow = db.prepare('SELECT MAX(version) AS m FROM notification_rules').get() as {
    m: number | null
  }
  const version = (maxRow.m ?? 0) + 1
  db.transaction(() => {
    db.prepare('UPDATE notification_rules SET is_active = 0 WHERE is_active = 1').run()
    db.prepare(
      'INSERT INTO notification_rules (version, rules, content_hash, is_active) VALUES (?, ?, ?, 1)',
    ).run(version, serialized, hash)
  })()
  return { published: true, version, content_hash: hash }
}

/**
 * 当前激活规则里的 `source_mapping`（包名→友好名）。
 *
 * 供 `/api/ai/parse` 机械补出参 `merchant`（契约 §6）——只读、只做抽取，
 * **绝不进 prompt**。直接读库而不走懒加载缓存，避免冷启动/换库时缓存未就绪。
 *
 * 从 `routes/notification-rules.ts` 挪到这里：`routes/ai.ts` 不应 import 另一个 route
 * （route → route 是分层倒挂）。
 */
export function getSourceMapping(db: Db = getDb()): Record<string, string> {
  const row = db
    .prepare('SELECT rules FROM notification_rules WHERE is_active = 1 ORDER BY id DESC LIMIT 1')
    .get() as { rules: string } | undefined
  if (!row) return {}
  try {
    const rules = JSON.parse(row.rules)
    const m = rules?.source_mapping
    if (m && typeof m === 'object' && !Array.isArray(m)) return m as Record<string, string>
  } catch {
    // 规则损坏时视为无映射：`merchant` 回落正文抽取，不让它阻断解析
  }
  return {}
}
