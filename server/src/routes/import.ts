/**
 * CSV 导入路由 - /api/import
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'

const importCsvSchema = z.object({
  content: z.string().min(1, 'CSV 内容不能为空'),
  source: z.enum(['wechat', 'alipay']),
})

interface ParsedTransaction {
  type: 'expense' | 'income' | 'transfer'
  amount: number // 分
  description: string
  date: string // YYYY-MM-DD
  source_detail: string
}

interface ParseResult {
  parsed: ParsedTransaction[]
  total: number
  skipped: number
  errors: number
}

/**
 * 解析 CSV 行，处理引号内的逗号
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current.trim())
  return fields
}

/**
 * 标准化日期格式为 YYYY-MM-DD
 */
function normalizeDate(raw: string): string {
  // 取前 10 位
  const datePart = raw.trim().substring(0, 10)
  // 将 / 替换为 -
  return datePart.replace(/\//g, '-')
}

/**
 * 解析微信账单
 */
function parseWechat(content: string): ParseResult {
  const lines = content.split(/\r?\n/)
  let headerIndex = -1

  // 找到表头行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('交易时间')) {
      headerIndex = i
      break
    }
  }

  if (headerIndex === -1) {
    return { parsed: [], total: 0, skipped: 0, errors: 0 }
  }

  const dataLines = lines.slice(headerIndex + 1).filter((l) => l.trim().length > 0)
  const total = dataLines.length
  let skipped = 0
  let errors = 0
  const parsed: ParsedTransaction[] = []

  for (const line of dataLines) {
    try {
      const fields = parseCsvLine(line)
      if (fields.length < 6) {
        errors++
        continue
      }

      // 列：交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
      const dateRaw = fields[0]
      const counterparty = fields[2]
      const description = fields[3]
      const direction = fields[4] // 收/支
      const amountRaw = fields[5]

      // type 映射
      let type: 'expense' | 'income' | 'transfer'
      if (direction === '支出') {
        type = 'expense'
      } else if (direction === '收入') {
        type = 'income'
      } else if (direction === '不计收支' || direction === '/') {
        skipped++
        continue
      } else {
        skipped++
        continue
      }

      // amount: 去掉 ¥ 和逗号，转浮点再*100
      const amountStr = amountRaw.replace(/[¥￥,\s]/g, '')
      const amountFloat = parseFloat(amountStr)
      if (isNaN(amountFloat)) {
        errors++
        continue
      }
      const amount = Math.round(amountFloat * 100)

      // date
      const date = normalizeDate(dateRaw)

      parsed.push({
        type,
        amount,
        description: description || counterparty || '',
        date,
        source_detail: `微信-${counterparty || ''}`,
      })
    } catch {
      errors++
    }
  }

  return { parsed, total, skipped, errors }
}

/**
 * 解析支付宝账单
 */
function parseAlipay(content: string): ParseResult {
  const lines = content.split(/\r?\n/)
  let headerIndex = -1
  let headerFields: string[] = []

  // 找到表头行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('交易号') || line.startsWith('账务流水号')) {
      headerIndex = i
      headerFields = parseCsvLine(line)
      break
    }
  }

  if (headerIndex === -1) {
    return { parsed: [], total: 0, skipped: 0, errors: 0 }
  }

  // 找列索引
  const colDate = headerFields.findIndex((h) => h.includes('交易创建时间') || h.includes('交易时间'))
  const colDescription = headerFields.findIndex((h) => h.includes('商品名称') || h.includes('商品说明'))
  const colAmount = headerFields.findIndex((h) => h.includes('金额'))
  const colDirection = headerFields.findIndex((h) => h === '收/支' || h.includes('收/支'))
  const colCounterparty = headerFields.findIndex((h) => h.includes('交易对方'))

  const dataLines = lines.slice(headerIndex + 1).filter((l) => l.trim().length > 0)
  const total = dataLines.length
  let skipped = 0
  let errors = 0
  const parsed: ParsedTransaction[] = []

  for (const line of dataLines) {
    try {
      const fields = parseCsvLine(line)
      if (fields.length < 5) {
        errors++
        continue
      }

      // 获取各字段
      const dateRaw = colDate >= 0 ? fields[colDate] : ''
      const description = colDescription >= 0 ? fields[colDescription] : ''
      const amountRaw = colAmount >= 0 ? fields[colAmount] : ''
      const direction = colDirection >= 0 ? fields[colDirection] : ''
      const counterparty = colCounterparty >= 0 ? fields[colCounterparty] : ''

      // type 映射
      let type: 'expense' | 'income' | 'transfer'
      const dirTrimmed = direction.trim()
      if (dirTrimmed === '支出') {
        type = 'expense'
      } else if (dirTrimmed === '收入') {
        type = 'income'
      } else if (dirTrimmed === '不计收支' || dirTrimmed === '') {
        skipped++
        continue
      } else {
        skipped++
        continue
      }

      // amount: 去掉空格，转浮点*100
      const amountStr = amountRaw.replace(/[\s,]/g, '')
      const amountFloat = parseFloat(amountStr)
      if (isNaN(amountFloat)) {
        errors++
        continue
      }
      const amount = Math.round(amountFloat * 100)

      // date
      if (!dateRaw) {
        errors++
        continue
      }
      const date = normalizeDate(dateRaw)

      parsed.push({
        type,
        amount,
        description: description || counterparty || '',
        date,
        source_detail: `支付宝-${counterparty || ''}`,
      })
    } catch {
      errors++
    }
  }

  return { parsed, total, skipped, errors }
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // POST /api/import/csv - 解析 CSV 账单预览
  app.post('/api/import/csv', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = importCsvSchema.safeParse(request.body)
    if (!body.success) {
      reply.code(400).send({
        code: 1,
        data: null,
        message: body.error.errors.map((e) => e.message).join('; '),
      })
      return
    }

    const { content, source } = body.data

    let result: ParseResult

    if (source === 'wechat') {
      result = parseWechat(content)
    } else {
      result = parseAlipay(content)
    }

    return {
      code: 0,
      data: result,
    }
  })
}
