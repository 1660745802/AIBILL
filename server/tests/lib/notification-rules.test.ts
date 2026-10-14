/**
 * 通知规则真源的纯逻辑回归（发布/真源规则见 docs/ARCHITECTURE.md §3.7）。
 *
 * 覆盖：validator 每条拒绝规则 + 接受路径；content hash 稳定性（testcases 不参与）；
 * publish 幂等 / 改文件后新版本；坏文件 fail-fast。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDb, getDb, closeDb } from '../../src/db/index.js'
import {
  loadRulesFile,
  validateRules,
  contentHash,
  corpusHash,
  buildPublishPayload,
  payloadHash,
  REQUIRED_RULES_SHAPE,
  regexPaths,
  APP_PROFILE_LIMITS,
  selfTestTestcases,
  publishRulesFromFile,
  stripTestcases,
  type RulesFile,
} from '../../src/lib/notification-rules.js'

const REAL_RULES_PATH = fileURLToPath(new URL('../../config/rules.json', import.meta.url))

/** 合法基线：直接读仓库真源，再按需改字段 */
const loadReal = (): RulesFile => JSON.parse(fs.readFileSync(REAL_RULES_PATH, 'utf8')) as RulesFile

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibill-rules-'))
const writeTmp = (name: string, obj: unknown): string => {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(obj))
  return p
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  closeDb()
})

describe('loadRulesFile', () => {
  it('缺失文件 → 抛错', () => {
    expect(() => loadRulesFile(path.join(tmpDir, 'nope.json'))).toThrow(/读取规则文件失败/)
  })

  it('损坏 JSON → 抛错', () => {
    const p = path.join(tmpDir, 'broken.json')
    fs.writeFileSync(p, '{ not json')
    expect(() => loadRulesFile(p)).toThrow(/解析规则文件失败/)
  })

  it('顶层不是对象 → 抛错', () => {
    const p = writeTmp('array.json', [1, 2, 3])
    expect(() => loadRulesFile(p)).toThrow(/顶层必须是 JSON 对象/)
  })
})

describe('validateRules · 拒绝规则', () => {
  it('接受仓库真源', () => {
    expect(validateRules(loadReal())).toEqual([])
  })

  it('未知顶层键 → 报错（不静默剥离）', () => {
    const r = loadReal()
    ;(r as Record<string, unknown>).unknown_top = 1
    expect(validateRules(r).join('|')).toContain('未知顶层键：unknown_top')
  })

  it('文件里写 precheck → 拒绝（它由代码派生，防手抄漂移）', () => {
    const r = loadReal()
    ;(r as Record<string, unknown>).precheck = {}
    expect(validateRules(r).join('|')).toContain('precheck 由代码派生')
  })

  /* lookaround 口径（本轮修正）：服务端自己的判据就在用 `(?<![\d.])` 这种
     **单字符类有界** lookbehind，而 Java 要求 lookbehind 定长——所以有界必须放行；
     变长 lookbehind（`(?<=a+)`）在 JVM 上编译不过，必须拦。 */
  it('有界 lookaround 放行 / 变长 lookaround 拒绝', () => {
    const allowed = ['(?<![\\d.])32元', '(?<=a)b', '(?!\\d)元', '(?=[¥￥])\\d+', '(?<![\\d.,])\\d+元']
    for (const pattern of allowed) {
      const r = loadReal()
      ;(r.nls as Record<string, unknown>).payment_signal_regex = pattern
      expect(validateRules(r).join('|'), pattern).not.toMatch(/lookaround/)
    }
    const rejected: Array<[string, RegExp]> = [
      ['(?<=a+)b', /变长 lookaround/],
      ['(?<!ab?)c', /变长 lookaround/],
      ['(?<=[a-z]{2,})x', /变长 lookaround/],
    ]
    for (const [pattern, re] of rejected) {
      const r = loadReal()
      ;(r.nls as Record<string, unknown>).payment_signal_regex = pattern
      expect(validateRules(r).join('|'), pattern).toMatch(re)
    }
  })

  /* 禁裸 \s/\S（JS 与 Java 语义不同），但 [\s\S] 这个「整字符」惯用法必须放行 */
  it('裸 \s/\S 拒绝；[\s\S] 放行', () => {
    const rej = loadReal()
    ;(rej.nls as Record<string, unknown>).payment_signal_regex = '元\\s*\\d+'
    expect(validateRules(rej).join('|')).toMatch(/不允许 \\s\/\\S/)

    const rej2 = loadReal()
    ;(rej2.nls as Record<string, unknown>).payment_signal_regex = '\\S+元'
    expect(validateRules(rej2).join('|')).toMatch(/不允许 \\s\/\\S/)

    const ok = loadReal()
    ;(ok.nls as Record<string, unknown>).payment_signal_regex = '[\\s\\S]{0,20}元'
    expect(validateRules(ok).join('|')).not.toMatch(/不允许 \\s\/\\S/)
  })


  it('命名组 / \\p{} / possessive / 内联 flags 仍全部拒绝', () => {
    const cases: Array<[string, RegExp]> = [
      ['(?<name>a)', /命名捕获组/],
      ['\\p{Script=Han}', /Unicode 属性/],
      ['a++', /possessive/],
      ['a*+', /possessive/],
      ['a?+', /possessive/],
      ['a{2,}+', /possessive/],
      ['(?i)abc', /内联 flags/],
    ]
    for (const [pattern, re] of cases) {
      const r = loadReal()
      ;(r.nls as Record<string, unknown>).payment_signal_regex = pattern
      expect(validateRules(r).join('|'), pattern).toMatch(re)
    }
  })

  it('无法编译的正则 → 拒绝', () => {
    const r = loadReal()
    ;(r.nls as Record<string, unknown>).payment_signal_regex = '(unclosed'
    expect(validateRules(r).join('|')).toMatch(/无法编译/)
  })

  it('缺少 nls.payment_signal_regex → 拒绝', () => {
    const r = loadReal()
    delete (r.nls as Record<string, unknown>).payment_signal_regex
    expect(validateRules(r).join('|')).toMatch(/缺少必需键：nls\.payment_signal_regex/)
  })

  it('processor 字段缺失 / 非正 / max<min → 拒绝', () => {
    const missing = loadReal()
    delete (missing.processor as Record<string, unknown>).dedup_window_seconds
    expect(validateRules(missing).join('|')).toMatch(/缺少必需键：processor\.dedup_window_seconds/)

    const negative = loadReal()
    ;(negative.processor as Record<string, unknown>).scoring_window_seconds = 0
    expect(validateRules(negative).join('|')).toMatch(/processor\.scoring_window_seconds 必须是正整数/)

    const inverted = loadReal()
    ;(inverted.processor as Record<string, unknown>).min_amount_cents = 100
    ;(inverted.processor as Record<string, unknown>).max_amount_cents = 1
    expect(validateRules(inverted)).toContain('processor.max_amount_cents 不能小于 min_amount_cents')
  })

  /* S6：必需形状清单。两道护栏：
     ① 逐条删除必需键都必须被拒绝（清单不是摆设，确实在卡）；
     ② 文件里任何「键名含 regex」的字符串都必须被清单覆盖——
        否则新加的 `a11y.exclude_pattern` 会静静地不被安全子集校验。 */
  it('REQUIRED_RULES_SHAPE 逐条删除都拒绝（含路径信息）', () => {
    expect(REQUIRED_RULES_SHAPE.length).toBeGreaterThan(10)
    for (const spec of REQUIRED_RULES_SHAPE) {
      const r = loadReal() as Record<string, unknown>
      const segs = spec.path.split('.')
      const last = segs.pop()!
      let cur: Record<string, unknown> = r
      for (const s of segs) cur = cur[s] as Record<string, unknown>
      delete cur[last]
      const errs = validateRules(r).join('|')
      expect(errs, `删掉 ${spec.path} 未被拒绝`).toMatch(
        new RegExp(`缺少必需键：${spec.path.replace(/\./g, '\\.')}`),
      )
    }
  })

  /* 可选键（云控调参）：缺失 = 客户端用内置默认 → 必须通过；出现则类型必须对
     （把类型写错会安静地把云控变成「发了一份坏参数」）。 */
  it('可选键 a11y.list_page_*：缺失通过；类型错拒绝', () => {
    const base = loadReal()
    delete ((base.a11y as Record<string, unknown>).list_page_keywords)
    delete ((base.a11y as Record<string, unknown>).list_page_min_amounts)
    expect(validateRules(base)).toEqual([]) // 缺失 = 用客户端内置默认

    const lk = loadReal()
    ;(lk.a11y as Record<string, unknown>).list_page_keywords = '账单' // 应为数组
    expect(validateRules(lk).join('|')).toMatch(/list_page_keywords 若出现必须是非空字符串数组/)

    const lk2 = loadReal()
    ;(lk2.a11y as Record<string, unknown>).list_page_keywords = []
    expect(validateRules(lk2).join('|')).toMatch(/list_page_keywords 若出现必须是非空字符串数组/)

    const lm = loadReal()
    ;(lm.a11y as Record<string, unknown>).list_page_min_amounts = 0
    expect(validateRules(lm).join('|')).toMatch(/list_page_min_amounts 若出现必须是正整数/)

    const lm2 = loadReal()
    ;(lm2.a11y as Record<string, unknown>).list_page_min_amounts = '3'
    expect(validateRules(lm2).join('|')).toMatch(/list_page_min_amounts 若出现必须是正整数/)
  })

  it('A11Y profile：缺失放行；全局 merchant_labels / profiles_schema 类型错拒绝', () => {
    const base = loadReal()
    delete (base.a11y as Record<string, unknown>).merchant_labels
    delete (base.a11y as Record<string, unknown>).profiles_schema
    expect(validateRules(base)).toEqual([]) // 缺失 = 客户端回退内置硬编码

    const ml = loadReal()
    ;(ml.a11y as Record<string, unknown>).merchant_labels = '收款方'
    expect(validateRules(ml).join('|')).toMatch(/merchant_labels 若出现必须是非空字符串数组/)

    const ml2 = loadReal()
    ;(ml2.a11y as Record<string, unknown>).merchant_labels = []
    expect(validateRules(ml2).join('|')).toMatch(/merchant_labels 若出现必须是非空字符串数组/)

    const ps = loadReal()
    ;(ps.a11y as Record<string, unknown>).profiles_schema = 0
    expect(validateRules(ps).join('|')).toMatch(/profiles_schema 若出现必须是正整数/)
  })

  it('A11Y profile：app_profiles 类型 / 逐键类型拒绝', () => {
    const notObj = loadReal()
    ;(notObj.a11y as Record<string, unknown>).app_profiles = []
    expect(validateRules(notObj).join('|')).toMatch(/app_profiles 若出现必须是对象/)

    const badKeys = loadReal()
    ;(badKeys.a11y as Record<string, unknown>).app_profiles = {
      'me.ele': {
        success_keywords: 'x',
        list_page_head_chars: 0,
        amount_view_id: '',
        merchant_labels: [''], // 元素非空串才行（空数组是合法的，见下一条）
      },
    }
    const errs = validateRules(badKeys).join('|')
    expect(errs).toMatch(/success_keywords 若出现必须是字符串数组/)
    expect(errs).toMatch(/list_page_head_chars 若出现必须是正整数/)
    expect(errs).toMatch(/amount_view_id 若出现必须是非空字符串/)
    expect(errs).toMatch(/merchant_labels 若出现必须是字符串数组/)
  })

  it('A11Y profile：profile 内数组允许为空（[] = 显式清空）；全局 a11y 数组仍非空', () => {
    const clear = loadReal()
    ;(clear.a11y as Record<string, unknown>).app_profiles = {
      'me.ele': { exclude_keywords: [], merchant_labels: [] },
    }
    expect(validateRules(clear)).toEqual([]) // profile 内空数组合法

    // 发布载荷必须**保留空数组**（不得被当「缺失」丢掉，否则客户端退回全局并集 = 清空失效）
    const payload = buildPublishPayload(clear).a11y as Record<string, unknown>
    const profile = (payload.app_profiles as Record<string, unknown>)['me.ele'] as Record<string, unknown>
    expect('exclude_keywords' in profile).toBe(true)
    expect(profile.exclude_keywords).toEqual([])

    // 全局 `a11y.merchant_labels` 沿用非空校验（与 profile 内语义不同）
    const globalEmpty = loadReal()
    ;(globalEmpty.a11y as Record<string, unknown>).merchant_labels = []
    expect(validateRules(globalEmpty).join('|')).toMatch(/merchant_labels 若出现必须是非空字符串数组/)
  })

  it('A11Y profile：amount_regex 过安全子集（裸 \\s / 变长 lookbehind 拒绝）', () => {
    const bare = loadReal()
    ;(bare.a11y as Record<string, unknown>).app_profiles = { 'me.ele': { amount_regex: '\\s' } }
    expect(validateRules(bare).join('|')).toMatch(/amount_regex: .*不允许 \\s/)

    const look = loadReal()
    ;(look.a11y as Record<string, unknown>).app_profiles = { 'me.ele': { amount_regex: '(?<=a+)x' } }
    expect(validateRules(look).join('|')).toMatch(/amount_regex: .*变长 lookaround/)

    const ok = loadReal()
    ;(ok.a11y as Record<string, unknown>).app_profiles = {
      'me.ele': { amount_regex: '[¥￥](\\d+\\.?\\d{0,2})' },
    }
    expect(validateRules(ok)).toEqual([])
  })

  it('A11Y profile：孤儿 profile 拒绝（不在 embedded_payment_apps）', () => {
    const orphan = loadReal()
    ;(orphan.a11y as Record<string, unknown>).app_profiles = {
      'com.unknown.app': { success_keywords: ['支付成功'] },
    }
    expect(validateRules(orphan).join('|')).toMatch(/孤儿 profile「com\.unknown\.app」/)

    const fixed = loadReal()
    ;((fixed.a11y as Record<string, unknown>).embedded_payment_apps as string[]).push('com.unknown.app')
    ;(fixed.a11y as Record<string, unknown>).app_profiles = {
      'com.unknown.app': { success_keywords: ['支付成功'] },
    }
    expect(validateRules(fixed)).toEqual([])
  })

  it('A11Y profile：包名非法（含空白 / 过长）拒绝', () => {
    const ws = loadReal()
    ;((ws.a11y as Record<string, unknown>).embedded_payment_apps as string[]).push('bad pkg')
    ;(ws.a11y as Record<string, unknown>).app_profiles = { 'bad pkg': {} }
    expect(validateRules(ws).join('|')).toMatch(/包名不得含空白字符/)

    const long = loadReal()
    const longPkg = 'a'.repeat(APP_PROFILE_LIMITS.maxPackageNameLen + 1)
    ;((long.a11y as Record<string, unknown>).embedded_payment_apps as string[]).push(longPkg)
    ;(long.a11y as Record<string, unknown>).app_profiles = { [longPkg]: {} }
    expect(validateRules(long).join('|')).toMatch(/包名过长/)
  })

  it('A11Y profile：超过 200 个 / 超过字节上限 → 拒绝（不静默截断）', () => {
    const many = loadReal()
    const pkgs = Array.from({ length: APP_PROFILE_LIMITS.maxProfiles + 1 }, (_, i) => `pkg.${i}`)
    const a11yMany = many.a11y as Record<string, unknown>
    a11yMany.embedded_payment_apps = pkgs
    a11yMany.app_profiles = Object.fromEntries(pkgs.map((p) => [p, {}]))
    expect(validateRules(many).join('|')).toMatch(/最多 200 个 profile/)

    const huge = loadReal()
    ;(huge.a11y as Record<string, unknown>).app_profiles = {
      // 类型合法，但序列化远超上限
      'me.ele': { merchant_labels: Array.from({ length: 20000 }, () => '标签字') },
    }
    expect(validateRules(huge).join('|')).toMatch(/序列化超过 \d+ 字节/)
  })

  it('A11Y profile：改 profile / merchant_labels → content_hash 变（客户端自动重拉）', () => {
    const a = loadReal() // 无 app_profiles
    const b = loadReal()
    ;(b.a11y as Record<string, unknown>).app_profiles = { 'me.ele': { success_keywords: ['支付成功'] } }
    expect(contentHash(b)).not.toBe(contentHash(a))

    const c = loadReal()
    ;(c.a11y as Record<string, unknown>).app_profiles = { 'me.ele': { success_keywords: ['支付完成'] } }
    expect(contentHash(c)).not.toBe(contentHash(b))

    const d = loadReal()
    ;(d.a11y as Record<string, unknown>).merchant_labels = ['收款方']
    expect(contentHash(d)).not.toBe(contentHash(a))

    // 载荷保留新键（真会下发，不是只进校验）
    const payloadA11y = buildPublishPayload(b).a11y as Record<string, unknown>
    expect(payloadA11y.app_profiles).toEqual({ 'me.ele': { success_keywords: ['支付成功'] } })
  })


  it('审计：文件里键名含 regex 的项都被清单覆盖（不许有漏网的正则）', () => {
    const r = loadReal() as Record<string, unknown>
    const found: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object') return
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k
        if (typeof val === 'string' && /regex/i.test(k)) found.push(p)
        else walk(val, p)
      }
    }
    walk(r, '')
    const covered = new Set(regexPaths())
    // profile 的 amount_regex 由 validateAppProfiles 单独过安全子集（路径是动态的，不在 regexPaths 里）
    const isProfileRegex = (p: string): boolean => /^a11y\.app_profiles\.[^.]+\.amount_regex$/.test(p)
    const uncovered = found.filter((p) => !covered.has(p) && !isProfileRegex(p))
    expect(uncovered, `这些正则键未被安全子集校验覆盖：${uncovered.join(', ')}`).toEqual([])
  })

  it('testcases 非法 tier / 空 text / 空 id → 拒绝', () => {
    const r = loadReal()
    r.testcases = [
      { id: 'a', text: 'x', expect_tier: 5 },
      { id: 'b', text: '', expect_tier: 1 },
      { id: '', text: 'y', expect_tier: 1 },
    ]
    const errs = validateRules(r).join('|')
    expect(errs).toMatch(/testcases\[0\]\.expect_tier/)
    expect(errs).toMatch(/testcases\[1\]\.text/)
    expect(errs).toMatch(/testcases\[2\]\.id/)
  })

  it('testcases 不是数组 → 拒绝', () => {
    const r = loadReal() as Record<string, unknown>
    r.testcases = {}
    expect(validateRules(r)).toContain('testcases 必须是数组')
  })

  /* 防「假映射」回归（客户端 2026-10 指出）：客户端预筛是另一套分类学，
     拿服务端 reason 当客户端断言 = 凭空造第三种口径。所以：
       ① `expect_client` 只允许 `pass`（不可拦）或缺省；
       ② 服务端自己的 reason 写 `expect_reason`；
       ③ `expect_txn` 必填——真交易不可拦的 P0 断言必须挂在它上面（不能拿 tier 当代理）。 */
  it('expect_client 写服务端 reason → 拒绝（假映射）', () => {
    const r = loadReal()
    r.testcases = [
      { id: 'fake-map', text: 'x', expect_tier: 0, expect_txn: false, expect_client: 'block:coupon_facevalue' },
    ]
    expect(validateRules(r).join('|')).toMatch(/expect_client 只允许 'pass' 或缺省/)
  })

  it('缺 expect_txn → 拒绝（P0 断言无锚）', () => {
    const r = loadReal()
    r.testcases = [
      { id: 'no-anchor', text: 'x', expect_tier: 0 } as unknown as RuleTestcase,
    ]
    expect(validateRules(r).join('|')).toMatch(/expect_txn 必须是 boolean/)
  })
})

describe('contentHash · 稳定性', () => {
  it('改 testcases → hash 不变（语料不进 hash）', () => {
    const a = loadReal()
    const b = loadReal()
    b.testcases = [{ id: 'changed', text: '完全不同的语料', expect_tier: 0 }]
    expect(contentHash(b)).toBe(contentHash(a))
  })

  it('改规则内容 → hash 变', () => {
    const a = loadReal()
    const b = loadReal()
    ;(b.processor as Record<string, unknown>).dedup_window_seconds = 61
    expect(contentHash(b)).not.toBe(contentHash(a))
  })

  it('键顺序无关（canonical JSON）', () => {
    const a: RulesFile = { nls: { payment_signal_regex: 'x' }, processor: { min: 1 } }
    const b: RulesFile = { processor: { min: 1 }, nls: { payment_signal_regex: 'x' } }
    expect(contentHash(a)).toBe(contentHash(b))
  })

  it('stripTestcases 剔除语料', () => {
    const r = loadReal()
    expect((stripTestcases(r) as Record<string, unknown>).testcases).toBeUndefined()
  })
})

describe('selfTestTestcases', () => {
  it('仓库语料全部通过', () => {
    expect(() => selfTestTestcases(loadReal())).not.toThrow()
  })

  it('期望 tier 不符 → 抛错并带 case id 与实际 tier', () => {
    const r = loadReal()
    r.testcases = [{ id: 'bad-case', text: '双11 5折', expect_tier: 1 }]
    expect(() => selfTestTestcases(r)).toThrow(/bad-case.*实际 tier=0/)
  })
})

describe('publishRulesFromFile · 幂等与版本', () => {
  beforeEach(() => {
    closeDb()
    initDb()
    getDb().exec('DELETE FROM notification_rules')
  })

  it('同一文件跑两次：只在第一次发布、版本不增', () => {
    const db = getDb()
    const p = writeTmp('rules-ok.json', loadReal())

    const first = publishRulesFromFile(db, p)
    expect(first.published).toBe(true)
    expect(first.version).toBe(1)

    const second = publishRulesFromFile(db, p)
    expect(second.published).toBe(false)
    expect(second.version).toBe(1)

    const count = db.prepare('SELECT COUNT(*) c FROM notification_rules').get() as { c: number }
    expect(count.c).toBe(1)
    const active = db.prepare('SELECT version, content_hash, is_active FROM notification_rules WHERE is_active = 1').get() as
      | { version: number; content_hash: string; is_active: number }
      | undefined
    expect(active?.version).toBe(1)
    expect(active?.content_hash).toBe(first.content_hash)
  })

  it('改文件后发布新版本并激活', () => {
    const db = getDb()
    const p1 = writeTmp('rules-v1.json', loadReal())
    const v1 = publishRulesFromFile(db, p1)

    const changed = loadReal()
    ;(changed.processor as Record<string, unknown>).dedup_window_seconds = 61
    const p2 = writeTmp('rules-v2.json', changed)
    const v2 = publishRulesFromFile(db, p2)

    expect(v2.published).toBe(true)
    expect(v2.version).toBe(v1.version + 1)
    expect(v2.content_hash).not.toBe(v1.content_hash)

    const active = db.prepare('SELECT version FROM notification_rules WHERE is_active = 1').get() as { version: number }
    expect(active.version).toBe(v2.version)
    const activeCount = db.prepare('SELECT COUNT(*) c FROM notification_rules WHERE is_active = 1').get() as { c: number }
    expect(activeCount.c).toBe(1)
  })

  it('坏文件 / 校验失败 → fail-fast，且不写坏数据', () => {
    const db = getDb()

    // 文件不存在
    expect(() => publishRulesFromFile(db, path.join(tmpDir, 'missing.json'))).toThrow()

    // 未知键
    const bad = loadReal() as Record<string, unknown>
    bad.unknown_top = 1
    const badPath = writeTmp('rules-bad.json', bad)
    expect(() => publishRulesFromFile(db, badPath)).toThrow(/未知顶层键：unknown_top/)

    // 语料自检失败
    const badCase = loadReal()
    badCase.testcases = [{ id: 'regression', text: '双11 5折', expect_tier: 1, expect_txn: false }]
    const badCasePath = writeTmp('rules-badcase.json', badCase)
    expect(() => publishRulesFromFile(db, badCasePath)).toThrow(/regression/)

    expect((db.prepare('SELECT COUNT(*) c FROM notification_rules').get() as { c: number }).c).toBe(0)
  })

  /* 老库（migration020 之前）的存量行：`rules` 里没有 precheck。
     加了 precheck 后载荷确实变了 → 升级后**首次启动会发布一个新版本**（这是对的：
     客户端必须重拉才能拿到判据）；再跑一次才回到幂等 no-op。 */
  it('老库 NULL content_hash：首次启动发布一个含 precheck 的新版本，再跑幂等', () => {
    const db = getDb()
    const rules = loadReal()
    // 模拟 migration020 之前的存量行：没有 content_hash、rules 里也没 precheck
    db.prepare('INSERT INTO notification_rules (version, rules, is_active) VALUES (1, ?, 1)').run(
      JSON.stringify(rules),
    )

    const p = writeTmp('rules-legacy.json', rules)
    const first = publishRulesFromFile(db, p)
    expect(first.published).toBe(true)
    expect(first.version).toBe(2)

    const active = db
      .prepare('SELECT content_hash, rules FROM notification_rules WHERE is_active = 1')
      .get() as { content_hash: string; rules: string }
    expect(active.content_hash).toBe(first.content_hash)
    expect(JSON.parse(active.rules).precheck?.schema).toBe(1)
    expect(JSON.parse(active.rules).testcases).toBeUndefined()

    // 第二次启动：载荷未变 → 幂等
    const second = publishRulesFromFile(db, p)
    expect(second.published).toBe(false)
    expect((db.prepare('SELECT COUNT(*) c FROM notification_rules').get() as { c: number }).c).toBe(2)
  })

  /* corpusHash：客户端 vendor 副本的漂移检测点。
     关键性质：① 同语料 → 稳定；② 语料变 → 变；③ **键序不影响**（客户端可自行重排）；
     ④ 不被 content_hash 包含（改语料不该让全体客户端重拉）。 */
  describe('corpusHash', () => {
    const a = [{ id: 'x', text: '午饭32', expect_tier: 1, tags: ['t'] }]

    it('同语料稳定、键序无关', () => {
      expect(corpusHash(a)).toBe(corpusHash(a))
      expect(corpusHash([{ text: '午饭32', id: 'x', expect_tier: 1, tags: ['t'] }])).toBe(corpusHash(a))
    })

    it('语料变更（含只改 tags）必须变', () => {
      expect(corpusHash([...a, { id: 'y', text: '打车15', expect_tier: 1 }])).not.toBe(corpusHash(a))
      expect(corpusHash([{ ...a[0]!, tags: ['t2'] }])).not.toBe(corpusHash(a))
    })

    it('不被 content_hash 纳入：改语料时 content_hash 不变', () => {
      const rules: RulesFile = { nls: {}, testcases: a }
      const changed: RulesFile = { nls: {}, testcases: [...a, { id: 'z', text: '地铁4', expect_tier: 1 }] }
      expect(contentHash(changed)).toBe(contentHash(rules))
      expect(corpusHash(changed.testcases)).not.toBe(corpusHash(rules.testcases))
    })
  })
})

/* ── prefilter_policy（云控归表，契约 docs/API.md 附录 C §11.2）───────────────
   客户端判据 id 的**闭集**（真源：AIBILL-ANDROID 的 `NotificationPrefilter.BlockReason`
   13 个 + `CaptureDrop` 派生出的 `client_only.capture_dropped_<channel>_<slug>`）。
   归表只允许出现这些 id —— 写错一个字云控就静默不生效，所以用测试钉住。 */
const BLOCK_REASON_NAMES = [
  'SELF_NOTIFICATION', 'DUPLICATE_CONTENT', 'BLANK_TEXT', 'SYSTEM_GROUP_SUMMARY',
  'SUMMARY_REPORT', 'PROMO_SENTENCE', 'MARKETING', 'NOT_FINANCIAL', 'LIST_PAGE',
  'AI_MEMORY', 'AI_MUTED', 'DB_DUPLICATE', 'PRECHECK',
] as const
const CAPTURE_DROP_SLUGS = [
  'nls_no_package', 'nls_no_extras',
  'sms_not_action', 'sms_no_messages', 'sms_blank_text',
  'a11y_not_whitelisted', 'a11y_no_root', 'a11y_root_mismatch', 'a11y_no_activity',
  'a11y_not_payment_activity', 'a11y_no_page_token', 'a11y_no_success_keyword',
  'a11y_excluded', 'a11y_bad_amount', 'a11y_history_date', 'a11y_debounce', 'a11y_page_dedup',
] as const
const KNOWN_CLIENT_RULE_IDS = new Set<string>([
  ...BLOCK_REASON_NAMES.map((n) => `client_only.${n}`),
  ...CAPTURE_DROP_SLUGS.map((s) => `client_only.capture_dropped_${s}`),
])

describe('validateRules · prefilter_policy（云控归表）', () => {
  it('缺失 → 放行（缺省 = 全 block，旧客户端零变化）', () => {
    const r = loadReal()
    delete r.prefilter_policy
    expect(validateRules(r)).toEqual([])
  })

  it('仓库真源通过校验，且键 ⊆ 已知客户端判据 id 闭集', () => {
    const r = loadReal()
    expect(validateRules(r)).toEqual([])
    const policy = r.prefilter_policy ?? {}
    expect(Object.keys(policy).length).toBeGreaterThan(0)
    for (const id of Object.keys(policy)) {
      expect(KNOWN_CLIENT_RULE_IDS.has(id), `归表里出现未知客户端判据 id：${id}`).toBe(true)
    }
  })

  it('非法键（非 precheck./client_only. 前缀）→ 拒绝', () => {
    const r = loadReal()
    r.prefilter_policy = { 'other.SUMMARY_REPORT': 'forward' } as never
    expect(validateRules(r).join('|')).toMatch(/prefilter_policy 的键必须是合法 rule_id/)
  })

  it('非法值 → 拒绝；非对象 → 拒绝', () => {
    const bad = loadReal()
    bad.prefilter_policy = { 'client_only.MARKETING': 'drop' } as never
    expect(validateRules(bad).join('|')).toMatch(/必须是 block\/forward\/sample/)

    const notObj = loadReal()
    notObj.prefilter_policy = ['forward'] as never
    expect(validateRules(notObj).join('|')).toMatch(/prefilter_policy 若出现必须是对象/)
  })

  it('进发布载荷，且改归表会换 content_hash（客户端据此重拉）', () => {
    const base = loadReal()
    expect((buildPublishPayload(base) as { prefilter_policy?: unknown }).prefilter_policy).toBeTruthy()

    const changed = loadReal()
    changed.prefilter_policy = { ...base.prefilter_policy, 'client_only.MARKETING': 'block' } as never
    expect(payloadHash(buildPublishPayload(changed))).not.toBe(payloadHash(buildPublishPayload(base)))
  })
})
