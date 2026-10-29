/**
 * CSV 导入路由 - /api/import
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { matchImportCategory, markDuplicates, type ImportCandidate } from '../lib/import-matcher.js'

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

/** CSV 解析器的原始产出（尚未附加分类/去重标记） */
interface RawParseResult {
  parsed: ParsedTransaction[]
  total: number
  skipped: number
  errors: number
}

/** 接口返回结构（已附加分类预填与去重标记） */
interface ParseResult extends Omit<RawParseResult, 'parsed'> {
  parsed: ImportCandidate[]
  duplicates: number
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
 * 标准化日期为 YYYY-MM-DD。
 *
 * 微信/支付宝导出的日期不保证补零（`2026/9/5 12:30`），原来只是 substring(0,10) +
 * 把 / 换成 -，会得到 `2026-9-5 1` 这种垃圾日期：预览里看不出来，用户点导入时
 * 被 `POST /transactions` 的 `^\d{4}-\d{2}-\d{2}$` 整批 400 拒掉。
 * 这里统一补零 + 校验真实历法（2026-13-45 / 2026-02-30 都不算日期），
 * 没法识别的返回 null，由调用方计入 errors。
 */
function normalizeDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 解析微信账单
 */
function parseWechat(content: string): RawParseResult {
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
      const amount = Math.round(amountFloat * 100)
      // 0 元 / 负金额（部分退款行）进不了账本：POST /transactions 只收 amount > 0。
      // 放它进预览，用户点导入时整批被 400 拒掉。
      if (!Number.isFinite(amount) || amount <= 0) {
        errors++
        continue
      }

      // date
      const date = normalizeDate(dateRaw)
      if (!date) {
        errors++
        continue
      }

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
function parseAlipay(content: string): RawParseResult {
  const lines = content.split(/\r?\n/)
  let headerIndex = -1
  let headerFields: string[] = []

  // 找到表头行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('交易号') || line.startsWith('账务流水号') || line.startsWith('交易时间,')) {
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
  const colStatus = headerFields.findIndex((h) => h === '交易状态' || h === '当前状态')
  const unpaidStatuses = new Set(['未付款', '等待付款', '等待买家付款', '交易关闭', '交易取消', '支付失败'])

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
      const status = colStatus >= 0 ? fields[colStatus]?.trim() : undefined
      // 只排除明确未成交状态；退款按收/支保留，旧 CSV 无状态列仍兼容。
      if (status && unpaidStatuses.has(status)) {
        skipped++
        continue
      }

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
      const amount = Math.round(amountFloat * 100)
      if (!Number.isFinite(amount) || amount <= 0) {
        errors++
        continue
      }

      // date
      if (!dateRaw) {
        errors++
        continue
      }
      const date = normalizeDate(dateRaw)
      if (!date) {
        errors++
        continue
      }

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
        code: 2000,
        data: null,
        message: body.error.errors.map((e) => e.message).join('; '),
      })
      return
    }

    const { content, source } = body.data
    const db = getDb()
    const userId = request.user!.userId

    let result: RawParseResult

    if (source === 'wechat') {
      result = parseWechat(content)
    } else {
      result = parseAlipay(content)
    }

    // ---- 分类预填：商户关键词 → 用户分类 ----
    if (result.parsed.length > 0) {
      const categories = db
        .prepare('SELECT id, name, type, icon FROM categories WHERE user_id = ? AND is_active = 1')
        .all(userId) as Array<{ id: number; name: string; type: 'expense' | 'income'; icon: string }>

      const enriched: ImportCandidate[] = result.parsed.map((item) => {
        const type = item.type === 'expense' ? 'expense' : item.type === 'income' ? 'income' : 'transfer'
        // 匹配文本 = 描述 + 交易对方（source_detail 形如「微信-美团」）
        const matched =
          type === 'transfer'
            ? { category_id: null, category_name: null, category_icon: null, category_auto: false }
            : matchImportCategory(`${item.description} ${item.source_detail}`, categories, type)

        return {
          ...item,
          type,
          ...matched,
          duplicate: false,
        }
      })

      // ---- 重复检测：与已有记录 / 批次内对比 ----
      const duplicates = markDuplicates(db, userId, enriched)

      const out: ParseResult = {
        parsed: enriched,
        total: result.total,
        skipped: result.skipped,
        errors: result.errors,
        duplicates,
      }
      return { code: 0, data: out }
    }

    return {
      code: 0,
      data: { ...result, duplicates: 0 } as ParseResult,
    }
  })
}
