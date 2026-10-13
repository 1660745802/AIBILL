/**
 * AI 失败的**类型枚举 + 重试策略 + 重试预算**（失败可观测的地基）
 *
 * 为什么要有这层：AI 失败（超时/上游 5xx/限流）**不进用户视野**——用户面对的原文
 * 可能没有金额，让他审等于形式上留痕、实质上丢弃。既然不打扰用户，那么
 * **「失败率 + 原因分布」就是唯一能发现「AI 挂了」的信号**，必须进管理面板。
 *
 * 与重试策略共用同一套枚举：**能被识别出来的失败类型，才谈得上"值不值得重试"**。
 * 之前只有 `error_message` 文本（`AI_TIMEOUT: ...` / `ParseError: ...`），聚合要靠
 * 切前缀，脆且两种格式不一 → migration 022 起单列 `ai_parse_logs.failure_code`。
 *
 * ⚠️ 判据只用「错误类型/HTTP 状态码」这种机械信息，**不看文案**（文案会改，判据不能跟着改）。
 */

/** 落库的失败类型（`ai_parse_logs.failure_code`；NULL = 没失败） */
export const AI_FAILURE_CODES = [
  'AI_TIMEOUT', // 本地超时（AbortController）
  'AI_NETWORK_ERROR', // 连不上/断流（DNS、TLS、socket）
  'AI_RATE_LIMIT', // 上游 429
  'AI_API_ERROR', // 上游非 2xx（4xx/5xx）
  'AI_EMPTY_RESPONSE', // 200 但 choices 为空（上游半挂）
  'AI_KEY_INVALID', // 401
  'AI_KEY_MISSING', // 本地未配置 Key
  'parse_format', // 模型返回的不是可解析 JSON（ParseError）
  'parse_invalid', // 能解析成 JSON，但机械校验后一条都不合法
  'input_empty', // 入参 `input` 为空（#8）—— 不是 AI 失败，但同样要可见
  'input_too_long', // 入参 `input` 超过渠道上限（#8）
] as const

export type AiFailureCode = (typeof AI_FAILURE_CODES)[number]

/**
 * 解析路径的**重试预算**（同步重试，必须装进客户端那 90s 的 HTTP 超时里）
 *
 * 现约束：客户端 AI 请求超时 90s（专项硬要求 ≥30s）。若沿用单次 60s 再重试一次，
 * 最坏 120s > 90s —— 第二次的结果客户端早已放弃，纯属白烧额度 + 占住连接。
 * 所以把**单次**超时压到 30s：`30s × 2 + 退避(<1s) ≈ 61s`，留 29s 余量。
 *
 * 为什么只能同步重试：本项目没有下发通道（无 push），auto-record 的结果必须随本次
 * 响应返回；异步重试即使成功也回不到用户手里，等于把失败藏起来。
 */
export const PARSE_MAX_ATTEMPTS = 2
export const PARSE_ATTEMPT_TIMEOUT_MS = 30_000

/**
 * 入参类失败（客户端入参问题）—— **不是「AI 挂了」**，不计入 `unavailable_rate`。
 * 仍会按 `by_failure_code` 单独可见（否则就是黑洞）；与 admin 统计的 SQL 口径对应。
 */
export const AI_INPUT_FAILURE_CODES = ['input_empty', 'input_too_long'] as const

/**
 * 「AI 不可用」失败集合 = 全部失败码 − 入参类。
 *
 * 这是**失败可观测 / 裁决面（`GET /api/admin/unparsed`）/ 双失败交叉核对的口径真源**——
 * 只此一处定义，SQL 用占位符展开（见 `routes/admin.ts`），谁都不许在别处再抄一份（抄了就会漂）。
 */
export const AI_UNAVAILABLE_FAILURE_CODES: readonly AiFailureCode[] = AI_FAILURE_CODES.filter(
  (c) => !(AI_INPUT_FAILURE_CODES as readonly string[]).includes(c),
)

/**
 * `input` 长度预算（契约 docs/API.md 附录 C §5）。
 *
 * - 一般渠道上限 3000（与旧契约一致，不变）；
 * - **a11y 放宽到 8000**：整页无障碍文本天然比通知长，用 3000 卡会把真账 400 在门外；
 *   仍超 8000 的头部截断后照常解析（截断是降级，不是失败，不置 `failure_code`）。
 *
 * 为什么必须在这层管：长度校验一旦扔给 zod 直接 400，**一行 `ai_parse_logs` 都不落**，
 * 于是「今天漏没漏账」两端都查不到（客户端只看到失败，服务端什么也没看到）。
 */
export const PARSE_INPUT_MAX_LEN = 3000
export const PARSE_INPUT_A11Y_MAX_LEN = 8000

/** 错误对象的最小形状（鸭子类型：不 import AiError/ParseError，避免 ai ↔ lib 循环依赖） */
interface ErrorLike {
  type?: unknown
  status?: unknown
  name?: unknown
  failureCode?: unknown
  retryAfterMs?: unknown
}

/** 把错误对象映射成落库用的失败类型；识别不了返回 `null`（交给上层决定） */
export function failureCodeOf(err: unknown): AiFailureCode | null {
  const e = (err ?? {}) as ErrorLike
  const type = typeof e.type === 'string' ? e.type : null
  if (type && (AI_FAILURE_CODES as readonly string[]).includes(type)) {
    return type as AiFailureCode
  }
  if (e.name === 'ParseError') {
    // parser.ts 在「JSON 合法但没有一条过校验」时置 failureCode='parse_invalid'，
    // 其余（抽不出 JSON）默认 parse_format。
    return e.failureCode === 'parse_invalid' ? 'parse_invalid' : 'parse_format'
  }
  return null
}

/**
 * 该失败**值不值得重试**（重试无意义或有害的一律 false）
 *
 * - `AI_TIMEOUT` / `AI_NETWORK_ERROR` / `AI_EMPTY_RESPONSE`：典型的瞬时故障 ✓
 * - `AI_RATE_LIMIT`：等一会儿再来 ✓（尊重 `Retry-After`）
 * - `AI_API_ERROR`：**只有 5xx 才重试**——4xx 是请求本身有问题，重试是浪费且会掩盖 bug
 * - `AI_KEY_INVALID` / `AI_KEY_MISSING`：配置问题，重一百次也一样 ✗
 * - `parse_format` / `parse_invalid`：模型输出抖动，再问一次有意义 ✓
 */
export function isRetryableFailure(err: unknown): boolean {
  const e = (err ?? {}) as ErrorLike
  const code = failureCodeOf(err)
  if (code === null) return false
  switch (code) {
    case 'AI_TIMEOUT':
    case 'AI_NETWORK_ERROR':
    case 'AI_EMPTY_RESPONSE':
    case 'AI_RATE_LIMIT':
    case 'parse_format':
    case 'parse_invalid':
      return true
    case 'AI_API_ERROR': {
      const status = typeof e.status === 'number' ? e.status : 0
      return status >= 500
    }
    default:
      return false
  }
}

/** 从错误对象上取上游给的 `Retry-After`（毫秒）；没有或形状不对返回 null */
export function retryAfterMsOf(err: unknown): number | null {
  const v = ((err ?? {}) as ErrorLike).retryAfterMs
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * 退避时长（ms）
 *
 * 有意做得**保守**：解析路径单次超时 30s，重试必须让总预算说得清。
 * 429 若给了 `Retry-After` 就听它的（但有上限，不能被上游拖死）。
 */
export function retryDelayMs(attempt: number, retryAfterMs?: number | null): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 2000)
  }
  const base = 300 * 2 ** (attempt - 1) // 300 / 600 / 1200…
  const jitter = Math.floor(Math.random() * 200)
  return base + jitter
}
