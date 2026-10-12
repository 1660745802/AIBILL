/**
 * 解析落地关联（parse-landing）的 TTL 语义
 *
 * 「AI 抽的数进没进账本」这个事实靠 (type, amount, date) 指纹关联解析日志与账单。
 * 指纹表是有 TTL 的（30 分钟，覆盖 94% 的解析→落库间隔）——过期还在关联，
 * 就会把几天前那次解析的 ai_raw_input / final_items 贴到刚记的账上。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rememberParse, matchParse, _resetLandingCache } from '../../src/lib/parse-landing.js'

const FP = { type: 'expense', amount: 3200, date: '2026-07-02' }

describe('parse-landing · TTL', () => {
  beforeEach(() => {
    _resetLandingCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('TTL 内可用指纹关联到解析日志', () => {
    rememberParse(1, 42, [FP], '午饭32')
    expect(matchParse(1, FP)).toEqual({ logId: 42, rawInput: '午饭32' })
  })

  it('超过 TTL 后不再关联（否则会把过期解析的结果贴到新账单上）', () => {
    const t0 = Date.now()
    rememberParse(1, 42, [FP], '午饭32')

    vi.useFakeTimers()
    vi.setSystemTime(t0 + 31 * 60 * 1000) // TTL = 30 分钟

    expect(matchParse(1, FP)).toBeNull()
  })

  it('同一指纹有多条候选时不猜（歧义）', () => {
    rememberParse(1, 42, [FP], '午饭32')
    rememberParse(1, 43, [FP], '午饭 32')
    expect(matchParse(1, FP)).toBeNull()
  })

  it('按 user 隔离：别人的指纹查不到', () => {
    rememberParse(1, 42, [FP], '午饭32')
    expect(matchParse(2, FP)).toBeNull()
  })

  it('没有日期或金额的条目不入指纹表', () => {
    rememberParse(1, 42, [{ type: 'expense', amount: 3200 }, { type: 'expense', amount: NaN, date: '2026-07-02' }], 'x')
    expect(matchParse(1, FP)).toBeNull()
  })
})
