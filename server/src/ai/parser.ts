/**
 * AI 响应解析器
 * 从 LLM 返回文本中提取 JSON 并校验格式
 */

export interface ParsedTransaction {
  type: 'expense' | 'income' | 'transfer'
  amount: number
  category: string
  description: string
  date: string
  account: string
  target_account?: string
}

/**
 * 从 LLM 响应文本中提取 JSON 数组
 * 兼容：纯 JSON、markdown 代码块包裹、前后有多余文字
 */
export function extractJsonArray(text: string): ParsedTransaction[] {
  // 尝试直接解析
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // 继续尝试其他方式
  }

  // 尝试提取 markdown 代码块中的 JSON
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1])
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 继续
    }
  }

  // 尝试提取方括号包裹的内容
  const bracketMatch = text.match(/\[[\s\S]*\]/)
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0])
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 最后的尝试失败
    }
  }

  throw new ParseError('无法从 AI 响应中提取有效 JSON')
}

/**
 * 校验并规范化解析结果
 */
export function validateParsedItems(items: ParsedTransaction[], today: string): ParsedTransaction[] {
  const validated: ParsedTransaction[] = []

  for (const item of items) {
    // type 必须合法
    if (!['expense', 'income', 'transfer'].includes(item.type)) {
      continue
    }

    // amount 必须有且大于 0
    let amount = Number(item.amount)
    if (!amount || isNaN(amount)) {
      // 尝试从字符串中提取数字（如 "¥32.00" 或 "32元"）
      if (typeof item.amount === 'string') {
        const numMatch = (item.amount as string).match(/[\d.]+/)
        amount = numMatch ? Number(numMatch[0]) : 0
      }
    }
    if (!amount || amount <= 0) {
      continue
    }

    // 边界保护：金额异常大（>1000万）可能是误提取
    if (amount > 10000000) {
      continue
    }

    // 描述不能是纯噪音（地址、按钮文字等）
    const desc = (item.description || '').trim()
    if (isNoiseDescription(desc)) {
      continue
    }

    validated.push({
      type: item.type,
      amount,
      category: item.category || '',
      description: desc.slice(0, 20),
      date: isValidDate(item.date) ? item.date : today,
      account: item.account || '',
      target_account: item.target_account || undefined,
    })
  }

  return validated
}

/**
 * 判断描述是否为噪音文本
 */
function isNoiseDescription(desc: string): boolean {
  if (!desc) return false
  const noisePatterns = [
    /^(去支付|确认|取消|返回|确定|确认领取)$/,
    /满\d+减\d+/,
    /满\d+可用/,
    /^\d+元起/,
  ]
  return noisePatterns.some((p) => p.test(desc))
}

/**
 * 简单日期格式校验
 */
function isValidDate(date: string): boolean {
  if (!date) return false
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date))
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}
