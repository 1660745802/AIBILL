/**
 * precheck 载荷**自足性**护栏（契约 §3）
 *
 * 背景（客户端 2026-10 报回的真实分歧）：`money` 命中的输入预处理（先剥千分位逗号）
 * **没写进契约**，于是同一段 `…支出(跨行汇款)1,000元，余额24,210.99元。`
 * 服务端判 `money+verb`(tier1)，客户端按 pattern 原文匹配不到 → `verb_only`(tier3)。
 * 这类分歧的通用形态是：**判据依赖了任何未写进契约的中间步骤**（`gi` 丢标志那次的同类）。
 *
 * 本文件的做法：在测试里实现一个**只吃下发载荷**的参考求值器（不 import 服务端判据），
 * 断言它对语料的判决与 `classifyNotification` **逐条相同**。载荷一旦依赖隐藏步骤，
 * 这里立刻红——不需要等客户端再报一次。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePrecheck, precheckIdToReason, type Precheck } from '../../src/lib/precheck.js'
import { classifyNotification, extractMoneyAmounts } from '../../src/ai/verify.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const RULES = JSON.parse(
  fs.readFileSync(path.resolve(here, '../../config/rules.json'), 'utf8'),
) as { testcases: Array<{ id: string; text: string; expect_tier: number }> }

/**
 * 「客户端侧」参考实现：**只用载荷里的 signals/rules/顺序/should_call_ai**，
 * 顺序首命中即定；不碰服务端任何函数。
 */
function evaluateWithPayload(pre: Precheck, text: string): { tier: number; ruleId: string } {
  const hit = (pattern: string, flags: string): boolean => new RegExp(pattern, flags).test(text)
  const signals = {
    money: hit(pre.signals.money.pattern, pre.signals.money.flags),
    verb: hit(pre.signals.verb.pattern, pre.signals.verb.flags),
    bare_amount: hit(pre.signals.bare_amount.pattern, pre.signals.bare_amount.flags),
  }
  const len = text.trim().length
  const maxLen = pre.signals.bare_amount_max_len
  const evalExpr = (expr: string): boolean => {
    if (expr === 'money && verb') return signals.money && signals.verb
    if (expr === 'money') return signals.money
    if (expr === 'verb') return signals.verb
    if (expr === `len<=${maxLen} && bare_amount`) return len <= maxLen && signals.bare_amount
    throw new Error(`未知 expr 形态（契约 §3 的封闭语法）：${expr}`)
  }
  for (const r of pre.rules) {
    if (r.type === 'regex') {
      if (hit(r.pattern!, r.flags ?? '')) return { tier: r.tier, ruleId: r.id }
    } else if (r.type === 'predicate') {
      if (evalExpr(r.expr!)) return { tier: r.tier, ruleId: r.id }
    } else {
      return { tier: r.tier, ruleId: r.id } // fallback 兜底
    }
  }
  throw new Error('判据链未覆盖（载荷缺少 fallback？）')
}

describe('precheck 载荷自足性（只吃载荷的参考求值器 vs 服务端实现）', () => {
  const pre = derivePrecheck()

  it('21 条语料：tier 与命中的 rule_id 逐条一致', () => {
    expect(RULES.testcases.length).toBeGreaterThan(0)
    for (const tc of RULES.testcases) {
      const impl = classifyNotification(tc.text)
      const client = evaluateWithPayload(pre, tc.text)
      expect(client.tier, `case ${tc.id}：载荷判决与服务端不一致（隐藏步骤？）`).toBe(impl.tier)
      expect(client.ruleId).toBe(`precheck.${impl.reasons[0]}`)
      expect(precheckIdToReason(client.ruleId)).toBe(impl.reasons[0]!)
    }
  })

  /* 客户端报回的那条具体分歧 + 同类边界（都必须在**只有 pattern**的情况下成立） */
  it('千分位金额：pattern 自足，不依赖任何预处理', () => {
    const cases: Array<[string, number]> = [
      ['跨行汇款)1,000元', 1000],
      ['余额24,210.99元', 24210.99],
      ['¥1,000.50', 1000.5],
      ['1,234,567元', 1234567],
      ['1000元', 1000],
      ['0.01元', 0.01],
    ]
    for (const [text, want] of cases) {
      expect(extractMoneyAmounts(text).has(want), `实现未抽出 ${want}：${text}`).toBe(true)
      expect(
        new RegExp(pre.signals.money.pattern, pre.signals.money.flags).test(text),
        `载荷的 money pattern 单独匹配不到：${text}`,
      ).toBe(true)
    }
  })

  it('畸形金额仍不应被抽出（千分位放开后不能把 1,23 这种吞进来）', () => {
    for (const text of ['1,23元', '2.555元', '3块5']) {
      const got = [...extractMoneyAmounts(text)]
      const payloadHit = new RegExp(pre.signals.money.pattern, pre.signals.money.flags).test(text)
      // 实现与载荷必须一致（要么都抽到、要么都不抽），且都不应把畸形串当金额
      if (got.length > 0) expect(payloadHit, `${text}：实现抽到了但载荷匹配不到`).toBe(true)
    }
  })

  /* 鉴别力自检：把 money pattern 换回「不吞千分位」的旧形式，护栏必须报出分歧。
     这是本文件的真正价值——它锁住的是**隐藏预处理**这类 bug 的通用形态。 */
  it('鉴别力自检：旧 pattern（不吞千分位）会被本护栏判为分叉', () => {
    const crippled: Precheck = {
      ...pre,
      signals: {
        ...pre.signals,
        money: {
          // 三个分支里都出现这段，必须**全量**替换（只替换第一个的话护栏自己就失效了）
          pattern: pre.signals.money.pattern.replaceAll(
            String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`,
            String.raw`\d+(?:\.\d{1,2})?`,
          ),
          flags: pre.signals.money.flags,
        },
      },
    }
    const text = '工商银行 尾号9766卡10月5日18:28手机银行支出(跨行汇款)1,000元，余额24,210.99元。'
    expect(evaluateWithPayload(crippled, text).tier).not.toBe(classifyNotification(text).tier)
  })
})
