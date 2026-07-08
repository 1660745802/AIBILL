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
 */
function getAiConfig(): { baseUrl: string; apiKey: string; model: string } {
  try {
    const db = getDb()
    const getVal = (key: string, fallback: string): string => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value || fallback
    }

    return {
      baseUrl: getVal('ai_base_url', config.aiBaseUrl),
      apiKey: getVal('ai_api_key', config.aiApiKey) || config.aiApiKey,
      model: getVal('ai_model', config.aiModel),
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
 */
export async function chatCompletion(
  messages: ChatMessage[],
  temperature = 0.1,
  timeoutMs = 10000,
): Promise<string> {
  const aiConfig = getAiConfig()

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
      throw new AiError('AI_API_ERROR', `AI 接口错误 (${response.status}): ${errorText.slice(0, 200)}`)
    }

    const data = (await response.json()) as ChatCompletionResponse
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      throw new AiError('AI_EMPTY_RESPONSE', 'AI 返回了空响应')
    }

    return content.trim()
  } catch (err) {
    if (err instanceof AiError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new AiError('AI_TIMEOUT', `AI 响应超时（${timeoutMs / 1000}秒）`)
    }
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
