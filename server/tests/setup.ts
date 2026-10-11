/**
 * Test setup: create a Fastify app with in-memory SQLite for each test suite
 *
 * 另外装一道**外发守卫**：任何测试都不许真的打第三方接口。
 *
 * 行情（腾讯 `qt.gtimg.cn`）和汇率（frankfurter.dev）都是非官方接口，
 * 之前有三个 route 测试直接在连它们，其中一条断言依赖活价——
 * 测试能不能过取决于**当天腾讯在不在**。这里让它变成硬失败：
 *
 *   1. 真外发当场抛错（即使被业务 try/catch 吞掉也不算数）；
 *   2. 记进 violations，`afterEach` 再抛一次——
 *      这样「吞错的静默外发」也一定会让用例红，不会悄悄混过去。
 *
 * 需要行情的测试请 mock `src/lib/quotes.js`（见 `tests/offline-quotes.ts`），
 * 需要外部 HTTP 的测试（AI、汇率兜底源）照旧自己 `vi.stubGlobal('fetch', ...)`。
 */
import { afterEach } from 'vitest'

// Override config before any app code loads
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
process.env.ADMIN_PASSWORD = 'testadmin123'
process.env.ADMIN_USERNAME = 'admin'
process.env.DB_PATH = ':memory:'

/** 允许的本地目标（测试夹具 / 本地 mock server）；其余一律算外发 */
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

const violations: string[] = []
const realFetch: typeof fetch = globalThis.fetch

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request).url
}

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = urlOf(input)
  if (/^https?:\/\//i.test(url) && !LOCAL_URL.test(url)) {
    violations.push(url)
    throw new Error(`[测试守卫] 禁止真实外发：${url} —— 请在测试里 mock 上游`)
  }
  return realFetch(input, init)
}) as typeof fetch

afterEach(() => {
  if (violations.length === 0) return
  const list = violations.splice(0, violations.length)
  throw new Error(`[测试守卫] 本用例发生了真实外发：${list.join(' , ')}`)
})
