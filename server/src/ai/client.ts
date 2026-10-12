/**
 * LLM 客户端封装
 * 统一调用 OpenAI 兼容接口，支持超时和错误处理
 */
import { config } from '../config.js'
import { getDb } from '../db/index.js'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

/**
 * 获取 AI 配置（优先读数据库 settings，fallback 到 env）
 *
 * 模型支持**用户级覆盖**：`user_settings.ai_model` > `settings.ai_model`（DATA.md §2.7）。
 * 之前只读全局 `settings`，而 `PUT /api/settings` 又把 `ai_model` 放进普通用户白名单
 * → 用户设了自己的模型却完全不生效（设置页是死设置）。传 `userId` 即生效。
 */
function getAiConfig(userId?: number): { baseUrl: string; apiKey: string; model: string } {
  try {
    const db = getDb()
    const getVal = (key: string, fallback: string): string => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value || fallback
    }

    let userModel: string | undefined
    if (userId != null) {
      const row = db
        .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
        .get(userId, 'ai_model') as { value: string } | undefined
      userModel = row?.value || undefined
    }

    return {
      baseUrl: getVal('ai_base_url', config.aiBaseUrl),
      apiKey: getVal('ai_api_key', config.aiApiKey) || config.aiApiKey,
      model: userModel || getVal('ai_model', config.aiModel),
    }
  } catch {
    return {
      baseUrl: config.aiBaseUrl,
      apiKey: config.aiApiKey,
      model: config.aiModel,
    }
  }
}

/**
 * 调用 LLM Chat Completion
 * @param messages 消息列表
 * @param temperature 温度参数
 * @param timeoutMs 超时毫秒数（默认 10000）
 * @param userId 传入则该用户的 `user_settings.ai_model` 覆盖全局模型
 */
export async function chatCompletion(
  messages: ChatMessage[],
  temperature = 0.1,
  timeoutMs = 10000,
  userId?: number,
): Promise<string> {
  const aiConfig = getAiConfig(userId)

  if (!aiConfig.apiKey || aiConfig.apiKey === 'sk-your-key') {
    throw new AiError('AI_KEY_MISSING', 'AI API Key 未配置，请在设置中填写')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages,
        temperature,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.error(`[AI] API error: status=${response.status}, body=${errorText.slice(0, 500)}`)
      if (response.status === 401) {
        throw new AiError('AI_KEY_INVALID', 'AI API Key 无效')
      }
      if (response.status === 429) {
        throw new AiError('AI_RATE_LIMIT', 'AI 请求频率超限，请稍后再试')
      }
      /* ⚠️ 只回状态码：上游正文可能含内部信息（甚至 Key 片段），
         而 ARCHITECTURE §5.2 要求响应不暴露内部信息。
         `errorText` 已在上面 `console.error` 完整落服务端日志，排查不受影响。 */
      throw new AiError('AI_API_ERROR', `AI 接口错误 (${response.status})`)
    }

    const data = (await response.json()) as ChatCompletionResponse
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      // 可能是 API 返回了错误结构（如 {"error": {...}}）
      console.error(`[AI] Empty/invalid response body: ${JSON.stringify(data).slice(0, 500)}`)
      throw new AiError('AI_EMPTY_RESPONSE', 'AI 返回了空响应')
    }

    return content.trim()
  } catch (err) {
    if (err instanceof AiError) throw err
    if ((err as Error).name === 'AbortError') {
      console.error(`[AI] Timeout after ${timeoutMs / 1000}s`)
      throw new AiError('AI_TIMEOUT', `AI 响应超时（${timeoutMs / 1000}秒）`)
    }
    console.error(`[AI] Network error: ${(err as Error).message}`)
    throw new AiError('AI_NETWORK_ERROR', `AI 网络错误: ${(err as Error).message}`)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * AI 错误类
 */
export class AiError extends Error {
  type: string
  constructor(type: string, message: string) {
    super(message)
    this.type = type
    this.name = 'AiError'
  }
}
