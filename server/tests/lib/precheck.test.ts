/**
 * `precheck` 下发载荷（契约 docs/API.md 附录 C §3）
 *
 * 这是 ④ 的核心：把服务端预筛判据原样交给客户端，让两边用**同一条 rule_id** 计数。
 * 所以本文件锁死的不只是形状，还有三条「不许漂移」的性质：
 *   ① `rule_id === 'precheck.' + 服务端 reason`（机械前缀，不是映射表）；
 *   ② 链的顺序与 tier 必须与 `classifyNotification` 一致（顺序即语义）；
 *   ③ 派生的正则**自己先过安全子集**（我们是自己的第一个用户）。
 */
import { describe, it, expect } from 'vitest'
import { derivePrecheck, precheckIdToReason } from '../../src/lib/precheck.js'
import {
  buildPublishPayload,
  payloadHash,
  contentHash,
  validateRules,
  stripTestcases,
  type RulesFile,
} from '../../src/lib/notification-rules.js'
import {
  classifyNotification,
  STRONG_NOISE_RULES,
  WEAK_NOISE_RULES,
  INBOUND_SIGNAL_SOURCES,
} from '../../src/ai/verify.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_RULES = path.resolve(here, '../../config/rules.json')
const loadReal = (): RulesFile => JSON.parse(fs.readFileSync(REAL_RULES, 'utf8')) as RulesFile

describe('derivePrecheck · 形状与链序', () => {
  const p = derivePrecheck()

  it('元信息：schema / 派生来源 / channel 无关 / 调用与佐证口径', () => {
    expect(p.schema).toBe(1)
    expect(p.derived_from).toBe('src/ai/verify.ts')
    expect(p.channel_agnostic).toBe(true)
    expect(p.should_call_ai).toBe('tier in (1,2,3)')
    expect(p.corroboration_required).toBe('tier in (2,3)')
  })

  it('信号正则齐全（客户端照此复现同一链）', () => {
    expect(p.signals.money.pattern.length).toBeGreaterThan(0)
    expect(p.signals.verb.pattern.length).toBeGreaterThan(0)
    expect(p.signals.bare_amount.pattern.length).toBeGreaterThan(0)
    expect(p.signals.bare_amount_max_len).toBe(30)
    expect(p.signals).toEqual(INBOUND_SIGNAL_SOURCES)
  })

  /* 回归：`signals.money` 发的是 `MONEY_RE.source` 时**丢了 `gi`** ——
     `rmb 100` 在服务端算金额、在客户端就不算。所以 flags 必须与 pattern 同发。 */
  it('信号必须带 flags（money=gi），且只允许 g/i/m', () => {
    expect(p.signals.money.flags).toBe('gi')
    expect(p.signals.verb.flags).toBe('')
    expect(p.signals.bare_amount.flags).toBe('')
    for (const s of [p.signals.money, p.signals.verb, p.signals.bare_amount]) {
      expect(s.flags, `非法 flags: ${s.flags}`).toMatch(/^[gim]*$/)
    }
  })

  it('money 信号确实大小写不敏感（复现服务端 gi 行为）', () => {
    const src = p.signals.money.pattern
    const flags = p.signals.money.flags
    expect(new RegExp(src, flags).test('RMB 100')).toBe(true)
    expect(new RegExp(src, flags).test('rmb 100')).toBe(true)
    expect(new RegExp(src, flags).test('美元 100')).toBe(false)
  })

  it('链序与 tier 逐条锁死（顺序即语义：正向信号先于弱噪声）', () => {
    const order = p.rules.map((r) => r.id)
    expect(order).toEqual([
      ...STRONG_NOISE_RULES.map((r) => `precheck.${r.name}`),
      'precheck.money+verb',
      ...WEAK_NOISE_RULES.map((r) => `precheck.${r.name}`),
      'precheck.money_only',
      'precheck.bare_amount',
      'precheck.verb_only',
      'precheck.no_signal',
    ])
    const tierOf = (id: string): number | undefined => p.rules.find((r) => r.id === id)?.tier
    expect(tierOf('precheck.money+verb')).toBe(1)
    expect(tierOf('precheck.money_only')).toBe(2)
    expect(tierOf('precheck.bare_amount')).toBe(2)
    expect(tierOf('precheck.verb_only')).toBe(3)
    expect(tierOf('precheck.no_signal')).toBe(4)
    for (const r of STRONG_NOISE_RULES) expect(tierOf(`precheck.${r.name}`)).toBe(0)
    for (const r of WEAK_NOISE_RULES) expect(tierOf(`precheck.${r.name}`)).toBe(0)
    // 五个 tier 全覆盖（客户端按 tier 决策，缺档会误判）
    expect(new Set(p.rules.map((r) => r.tier))).toEqual(new Set([0, 1, 2, 3, 4]))
  })

  it('id 唯一、非空 desc、regex 规则带 pattern、predicate 规则带 expr', () => {
    const ids = p.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of p.rules) {
      expect(r.desc.length).toBeGreaterThan(0)
      if (r.type === 'regex') {
        expect(r.pattern?.length).toBeGreaterThan(0)
        expect(r.flags, `非法 flags: ${r.flags}`).toMatch(/^[gim]*$/)
      }
      if (r.type === 'predicate') expect(r.expr?.length).toBeGreaterThan(0)
      if (r.type === 'fallback') expect(r.tier).toBe(4)
    }
  })

  it('expr 只允许封闭小语法（signal / signal && signal / len<=N && signal）', () => {
    /* 客户端按「封闭小语法」实现取值器，未知形态会**忽略该条 + 计数 precheck_unknown_expr**
       （fail-safe，不当命中/不命中猜）。所以服务端必须自证：只产出这三种形态。
       将来要扩形态：先改契约 §3 并播报，不要惄惄加一个新 expr。 */
    const signalNames = Object.keys(p.signals).filter((k) => k !== 'bare_amount_max_len')
    const GRAMMAR = [
      /^([a-z_]+)$/,
      /^([a-z_]+) && ([a-z_]+)$/,
      /^len<=(\d+) && ([a-z_]+)$/,
    ]
    const exprs = p.rules.filter((r) => r.type === 'predicate').map((r) => r.expr ?? '')
    expect(exprs.length).toBeGreaterThan(0)
    for (const expr of exprs) {
      const matched = GRAMMAR.some((g) => g.test(expr))
      expect(matched, `expr 不在封闭语法内：${JSON.stringify(expr)}`).toBe(true)
      // 引用的 signal 必须真实存在于 signals 中（否则客户端会当成未知）。
      // ”unit” 对应 signals.bare_amount_max_len（长度阈值），单独判。
      const refs = expr.match(/[a-z_]+/g) ?? []
      for (const ref of refs) {
        if (ref === 'len') continue
        expect(signalNames, `expr 引用了不存在的 signal：${ref}`).toContain(ref)
      }
    }
    // fallback 不带 expr
    for (const r of p.rules.filter((r) => r.type === 'fallback')) expect(r.expr).toBeUndefined()
  })

  it('确定性：两次调用深度相等（否则每次启动都会换 hash）', () => {
    expect(derivePrecheck()).toEqual(derivePrecheck())
  })
})

describe('precheck · 与服务端 reason 的 1:1（防漂移）', () => {
  const p = derivePrecheck()

  it('rule_id = precheck. + 服务端 reason（机械前缀，不是映射表）', () => {
    expect(precheckIdToReason('precheck.money+verb')).toBe('money+verb')
    // 4 个非噪声档位就是 classifyNotification 里逐字写死的 reason
    for (const r of ['money+verb', 'money_only', 'bare_amount', 'verb_only', 'no_signal']) {
      expect(p.rules.some((x) => x.id === `precheck.${r}`)).toBe(true)
    }
  })

  it('语料实测出的每个服务端 reason 都在 precheck 清单里（真实漂移护栏）', () => {
    const rules = loadReal()
    const precheckReasons = new Set(p.rules.map((r) => precheckIdToReason(r.id)))
    for (const tc of rules.testcases ?? []) {
      for (const reason of classifyNotification(tc.text).reasons) {
        expect(precheckReasons, `case ${tc.id} 的 reason=${reason} 未出现在 precheck`).toContain(reason)
      }
    }
  })

  it('派生的正则自己先过安全子集（我们是自己的第一个用户）', () => {
    for (const r of p.rules) {
      if (r.type !== 'regex' || !r.pattern) continue
      const errs = validateRules({ nls: { payment_signal_regex: r.pattern } }).filter((e) =>
        /不允许|无法编译/.test(e),
      )
      expect(errs, `${r.id} 的 pattern 未通过安全子集：${errs.join(';')}`).toEqual([])
      // 信号正则同样要过
    }
    for (const [name, pattern] of Object.entries({
      money: p.signals.money.pattern,
      verb: p.signals.verb.pattern,
      bare_amount: p.signals.bare_amount.pattern,
    })) {
      const errs = validateRules({ nls: { payment_signal_regex: pattern } }).filter((e) =>
        /不允许|无法编译/.test(e),
      )
      expect(errs, `signal ${name} 未通过安全子集：${errs.join(';')}`).toEqual([])
    }
  })
})

describe('precheck · 进发布载荷与 hash', () => {
  it('buildPublishPayload：剔除 testcases、注入 precheck', () => {
    const payload = buildPublishPayload(loadReal())
    expect(payload.testcases).toBeUndefined()
    expect((payload as Record<string, unknown>).precheck).toBeDefined()
    expect(stripTestcases(payload).testcases).toBeUndefined()
  })

  it('precheck 参与 payloadHash（代码改判据 → 客户端会重拉）', () => {
    const file = loadReal()
    const payload = buildPublishPayload(file)
    expect(payloadHash(payload)).not.toBe(contentHash(file))
    // 去掉 precheck 后 hash 必变 —— 证明它确实被纳入
    const withoutPrecheck = stripTestcases(payload) as Record<string, unknown>
    delete withoutPrecheck.precheck
    expect(payloadHash(withoutPrecheck as RulesFile)).not.toBe(payloadHash(payload))
  })

  it('语料仍不进 payloadHash（改 testcases 不该让全体重拉）', () => {
    const a = buildPublishPayload(loadReal())
    const b = buildPublishPayload({ ...loadReal(), testcases: [] })
    expect(payloadHash(b)).toBe(payloadHash(a))
  })
})
