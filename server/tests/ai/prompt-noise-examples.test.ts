/**
 * 这条测试在锁什么
 * ----------------
 * `PROMPT_NOISE_EXAMPLES` 抽成常量之后，**渲染出来的 prompt 必须一字不变**。
 *
 * 抽常量的风险不在「文案被改」（改了就该被评审看见），而在**下标对错位**：
 * 例句是按 `PROMPT_NOISE_EXAMPLES[0]!.text` 插进两个模板的，
 * 一旦数组顺序调整，quick prompt 就会拿「余额提醒」当「券面额」的示范，
 * 而 prompt 文本本身看着完全正常 —— 没有任何测试会红，模型却被教错了。
 *
 * 所以这里锁两件事：
 * 1. 每条例句都出现在**它该出现**的那个 prompt 里（quick / full 各自的例句集合）；
 * 2. prompt 里出现的「不是账」例句，**只来自这张常量表**（不多、不少），
 *    即：有人绕过常量直接往模板里写死例句，会被这条断言逮住。
 */
import { describe, it, expect } from 'vitest'
import { buildParsePrompt, PROMPT_NOISE_EXAMPLES } from '../../src/ai/prompts.js'

const ctx = {
  today: '2026-10-13',
  expenseCategories: ['餐饮', '交通'],
  incomeCategories: ['工资', '红包'],
  accounts: ['微信'],
}
const quick = buildParsePrompt(ctx, 10)
const full = buildParsePrompt(ctx, 200)

/** 「输入：xxx\n输出：[]」这种噪声例句行 */
function noiseExampleLines(prompt: string): string[] {
  const re = /输入：(.+)\n输出：\[\]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) out.push(m[1]!)
  return out
}

/**
 * 「不是账、但**不是噪声**」的 prompt 负例：它们**不在** PROMPT_NOISE_EXAMPLES 里，
 * 因为 C4 要求那张表的例句必须被服务端判为 tier 0，而这条带「支付成功」是 tier 1
 *（它示范的是「原文没金额就别编」，不是「这是广告」）。列在这里是为了把
 * 「prompt 里的负例只能来自这两个来源」这条断言写完整。
 */
const NON_NOISE_NEGATIVES = [
  '南方航空 您的机票已于2026-08-11支付成功，乘机人李昆鸿，票号7842305955315，北京大兴机场→重庆江北机场。',
]

describe('prompt 里的噪声例句与常量表同源', () => {
  it('每条例句都至少出现在一个 prompt 里（没有被下标错位挤掉）', () => {
    for (const e of PROMPT_NOISE_EXAMPLES) {
      expect(`${quick}\n${full}`).toContain(e.text)
    }
  })

  it('prompt 里的噪声例句**只**来自这张表（不多不少）', () => {
    const expected = new Set([
      ...PROMPT_NOISE_EXAMPLES.map((e) => e.text),
      ...NON_NOISE_NEGATIVES,
    ])
    const lines = new Set([...noiseExampleLines(quick), ...noiseExampleLines(full)])
    expect(lines.size).toBeGreaterThan(0)
    for (const line of lines) expect(expected.has(line)).toBe(true)
    // 反向：常量表里每条都必须真的渲染进了 prompt（否则「同源」是空话）
    for (const e of PROMPT_NOISE_EXAMPLES) expect(lines.has(e.text)).toBe(true)
  })

  it('券面额例句在 quick 与 full 两份 prompt 里都在（同一句、同一位置角色）', () => {
    const coupon = PROMPT_NOISE_EXAMPLES[0]!.text
    expect(quick).toContain(coupon)
    expect(full).toContain(coupon)
  })

  it('例句 id 唯一（冲突报告与测试都靠它定位）', () => {
    const ids = PROMPT_NOISE_EXAMPLES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})