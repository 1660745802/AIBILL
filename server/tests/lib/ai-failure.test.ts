/**
 * AI 失败分类与重试策略（`lib/ai-failure.ts`）
 *
 * 这层是「失败可观测 + 有限重试」的**唯一判据源**：路由用 `failureCodeOf` 落库、
 * 用 `isRetryableFailure` 决定要不要再问一次上游。判据一旦漂了，两边同时失真，
 * 所以逐条锁死。**判据只看错误类型/HTTP 状态码，不看文案**。
 */
import { describe, it, expect } from 'vitest'
import {
  failureCodeOf,
  isRetryableFailure,
  retryAfterMsOf,
  retryDelayMs,
  PARSE_MAX_ATTEMPTS,
  PARSE_ATTEMPT_TIMEOUT_MS,
} from '../../src/lib/ai-failure.js'

/** 鸭子类型错误对象（路由里抛出的 AiError / ParseError 的最小形状） */
const aiErr = (type: string, status?: number, retryAfterMs?: number) => ({ type, status, retryAfterMs })
const parseErr = (failureCode?: string) => ({ name: 'ParseError', failureCode })

describe('failureCodeOf', () => {
  it('识别 AiError 的 type', () => {
    expect(failureCodeOf(aiErr('AI_TIMEOUT'))).toBe('AI_TIMEOUT')
    expect(failureCodeOf(aiErr('AI_NETWORK_ERROR'))).toBe('AI_NETWORK_ERROR')
    expect(failureCodeOf(aiErr('AI_RATE_LIMIT'))).toBe('AI_RATE_LIMIT')
    expect(failureCodeOf(aiErr('AI_KEY_MISSING'))).toBe('AI_KEY_MISSING')
    expect(failureCodeOf(aiErr('AI_API_ERROR', 500))).toBe('AI_API_ERROR')
  })

  it('ParseError 默认 parse_format；带 parse_invalid 标记时如实返回', () => {
    expect(failureCodeOf(parseErr())).toBe('parse_format')
    expect(failureCodeOf(parseErr('parse_invalid'))).toBe('parse_invalid')
  })

  it('认不出的形状返回 null（不猜）', () => {
    expect(failureCodeOf(new Error('boom'))).toBeNull()
    expect(failureCodeOf(null)).toBeNull()
    expect(failureCodeOf(aiErr('SOMETHING_ELSE'))).toBeNull()
  })
})

describe('isRetryableFailure', () => {
  it('瞬时故障可重试', () => {
    for (const t of ['AI_TIMEOUT', 'AI_NETWORK_ERROR', 'AI_EMPTY_RESPONSE', 'AI_RATE_LIMIT']) {
      expect(isRetryableFailure(aiErr(t)), t).toBe(true)
    }
    expect(isRetryableFailure(parseErr())).toBe(true)
    expect(isRetryableFailure(parseErr('parse_invalid'))).toBe(true)
  })

  it('上游 5xx 可重试、4xx 不重试（判据是 status，不是文案）', () => {
    expect(isRetryableFailure(aiErr('AI_API_ERROR', 500))).toBe(true)
    expect(isRetryableFailure(aiErr('AI_API_ERROR', 503))).toBe(true)
    expect(isRetryableFailure(aiErr('AI_API_ERROR', 400))).toBe(false)
    // 没有 status 时保守判为不可重试（旧错误对象形状）
    expect(isRetryableFailure(aiErr('AI_API_ERROR'))).toBe(false)
  })

  it('配置类问题永不可重试', () => {
    expect(isRetryableFailure(aiErr('AI_KEY_INVALID', 401))).toBe(false)
    expect(isRetryableFailure(aiErr('AI_KEY_MISSING'))).toBe(false)
  })
})

describe('重试预算（必须装进客户端 90s HTTP 超时）', () => {
  it('单次超时 × 次数 + 退避上界 < 90s', () => {
    const worstBackoff = retryDelayMs(1, 2000) * (PARSE_MAX_ATTEMPTS - 1)
    expect(PARSE_ATTEMPT_TIMEOUT_MS * PARSE_MAX_ATTEMPTS + worstBackoff).toBeLessThan(90_000)
  })

  it('Retry-After 优先但有上限（不能被上游拖死）', () => {
    expect(retryDelayMs(1, 500)).toBe(500)
    expect(retryDelayMs(1, 60_000)).toBe(2000)
    const backoff = retryDelayMs(1)
    expect(backoff).toBeGreaterThanOrEqual(300)
    expect(backoff).toBeLessThan(600)
  })

  it('retryAfterMsOf 只认正有限数', () => {
    expect(retryAfterMsOf(aiErr('AI_RATE_LIMIT', 429, 1500))).toBe(1500)
    expect(retryAfterMsOf(aiErr('AI_RATE_LIMIT'))).toBeNull()
    expect(retryAfterMsOf(aiErr('AI_RATE_LIMIT', 429, 0))).toBeNull()
  })
})
