/**
 * LLM 客户端的错误文案
 *
 * 回归：`AI_API_ERROR` 曾把上游响应体前 200 字拼进 message，而 routes/ai.ts
 * 把这个 message 原样回给客户端 —— 上游的 400/500 正文里可能带内部信息
 * （provider 的 trace、甚至 Key 片段），违反 DEVELOPMENT §5.2「响应不暴露内部信息」。
 * 现在只回状态码；完整正文只进服务端日志（client.ts 里的 console.error）。
 *
 * 全部离线：`fetch` 被 stub，不出网。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// ⚠️ 必须在 import client 之前把 Key 配上：client 在模块加载时读 config，
// 而默认值 `sk-your-key` 会先撞上 AI_KEY_MISSING。
process.env.AI_API_KEY = 'sk-test-fake-key'
const { chatCompletion, AiError } = await import('../../src/ai/client.js')

describe('chatCompletion 的错误处理', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stub = (status: number, body: string) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))

  it('非 2xx：客户端只看到状态码，上游正文不外泄', async () => {
    stub(500, '{"error":{"message":"internal trace abc","key":"sk-live-LEAKED-123"}}')
    const err = (await chatCompletion([{ role: 'user', content: 'hi' }]).catch((e) => e)) as Error
    expect(err).toBeInstanceOf(AiError)
    expect(err.message).toContain('500')
    expect(err.message).not.toContain('sk-live-LEAKED-123')
    expect(err.message).not.toContain('internal trace')
  })

  it('401 / 429 仍是可读的友好文案', async () => {
    stub(401, '{"error":"invalid key sk-live-LEAKED-123"}')
    const e401 = (await chatCompletion([{ role: 'user', content: 'hi' }]).catch((e) => e)) as Error
    expect(e401.message).toContain('Key 无效')
    expect(e401.message).not.toContain('sk-live-LEAKED-123')

    stub(429, '{"error":"rate limited"}')
    const e429 = (await chatCompletion([{ role: 'user', content: 'hi' }]).catch((e) => e)) as Error
    expect(e429.message).toContain('频率超限')
  })
})
