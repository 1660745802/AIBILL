/**
 * AI 路由 - /api/ai
 * POST /api/ai/parse - AI 记账解析
 * POST /api/ai/chat - AI 问答
 * GET /api/ai/sessions - 对话列表
 * DELETE /api/ai/sessions/:id - 删除对话
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import crypto from 'node:crypto'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { chatCompletion, AiError } from '../ai/client.js'
import { buildParsePrompt } from '../ai/prompts.js'
import { extractJsonArray, validateParsedItems, ParseError } from '../ai/parser.js'
import { matchCategory } from '../ai/category-matcher.js'

const parseInputSchema = z.object({
  input: z.string().min(1, '输入不能为空').max(500, '输入过长'),
})

interface CategoryRow {
  id: number
  name: string
  type: string
  icon: string
}

interface AccountRow {
  id: number
  name: string
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // POST /api/ai/parse - AI 记账解析
  app.post('/api/ai/parse', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = parseInputSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 获取用户的分类和账户列表
      const categories = db
        .prepare('SELECT id, name, type, icon FROM categories WHERE user_id = ? AND is_active = 1')
        .all(userId) as CategoryRow[]

      const accounts = db
        .prepare('SELECT id, name FROM accounts WHERE user_id = ? AND is_active = 1')
        .all(userId) as AccountRow[]

      const expenseCategories = categories.filter((c) => c.type === 'expense')
      const incomeCategories = categories.filter((c) => c.type === 'income')

      // 构建 prompt
      const today = new Date().toISOString().slice(0, 10)
      const systemPrompt = buildParsePrompt({
        today,
        expenseCategories: expenseCategories.map((c) => c.name),
        incomeCategories: incomeCategories.map((c) => c.name),
        accounts: accounts.map((a) => a.name),
      })

      // 预清理输入文本（去除通知标题噪音）
      const cleanedInput = cleanInput(body.input)

      // 调用 LLM
      const aiResponse = await chatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: cleanedInput },
        ],
        0.1,
        60000,
      )

      // 解析响应
      const rawItems = extractJsonArray(aiResponse)
      const validItems = validateParsedItems(rawItems, today)

      if (validItems.length === 0) {
        reply.code(200)
        return {
          code: 5001,
          data: null,
          message: 'AI 无法解析，请尝试手动记账',
          fallback: 'manual',
          raw_input: body.input,
        }
      }

      // 匹配分类 ID + 账户 ID
      const result = validItems.map((item) => {
        // 分类匹配（transfer 不需要分类）
        let categoryId: number | null = null
        let categoryName = ''
        let categoryIcon = ''

        if (item.type !== 'transfer') {
          const type = item.type === 'expense' ? 'expense' : 'income'
          const matched = matchCategory(
            item.category,
            categories.map((c) => ({ id: c.id, name: c.name, type: c.type as 'expense' | 'income' })),
            type,
          )
          categoryId = matched.id
          categoryName = matched.name
          const catRow = categories.find((c) => c.id === matched.id)
          categoryIcon = catRow?.icon || '📦'
        }

        // 账户匹配
        let accountId: number | null = null
        let accountName = ''
        if (item.account) {
          const matchedAccount = accounts.find(
            (a) => a.name === item.account || a.name.includes(item.account) || item.account.includes(a.name),
          )
          if (matchedAccount) {
            accountId = matchedAccount.id
            accountName = matchedAccount.name
          }
        }

        // 目标账户匹配（转账）
        let targetAccountId: number | null = null
        let targetAccountName = ''
        if (item.type === 'transfer' && item.target_account) {
          const matchedTarget = accounts.find(
            (a) => a.name === item.target_account || a.name.includes(item.target_account!) || item.target_account!.includes(a.name),
          )
          if (matchedTarget) {
            targetAccountId = matchedTarget.id
            targetAccountName = matchedTarget.name
          }
        }

        return {
          type: item.type,
          amount: Math.round(item.amount * 100), // 元转分
          category_id: categoryId,
          category_name: categoryName,
          category_icon: categoryIcon,
          description: item.description,
          date: item.date,
          account_id: accountId,
          account_name: accountName,
          target_account_id: targetAccountId,
          target_account_name: targetAccountName,
        }
      })

      return {
        code: 0,
        data: { items: result, raw_input: body.input },
        message: '',
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof AiError) {
        const statusCode = err.type === 'AI_TIMEOUT' ? 504 : 502
        reply.code(statusCode)
        return {
          code: 5001,
          data: null,
          message: err.message,
          fallback: 'manual',
          raw_input: (request.body as any)?.input || '',
        }
      }
      if (err instanceof ParseError) {
        reply.code(200)
        return {
          code: 5002,
          data: null,
          message: 'AI 返回格式异常，请尝试手动记账',
          fallback: 'manual',
          raw_input: (request.body as any)?.input || '',
        }
      }
      throw err
    }
  })

  // ============ AI 问答 ============

  const chatInputSchema = z.object({
    message: z.string().min(1, '消息不能为空').max(1000),
    session_id: z.string().uuid().optional(),
  })

  // POST /api/ai/chat - AI 问答
  app.post('/api/ai/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = chatInputSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 生成或复用 session_id
      const sessionId = body.session_id || crypto.randomUUID()

      // 获取用户财务数据摘要（当月+上月）
      const now = new Date()
      const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`

      const summaryData = db
        .prepare(
          `SELECT
            substr(date, 1, 7) as month,
            type,
            SUM(amount) as total,
            COUNT(*) as count
           FROM transactions
           WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
             AND type IN ('expense', 'income')
             AND substr(date, 1, 7) IN (?, ?)
           GROUP BY substr(date, 1, 7), type`,
        )
        .all(userId, thisMonth, prevMonth) as Array<{ month: string; type: string; total: number; count: number }>

      const categorySummary = db
        .prepare(
          `SELECT c.name, SUM(t.amount) as total, COUNT(*) as count
           FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
             AND t.type = 'expense'
             AND substr(t.date, 1, 7) = ?
           GROUP BY t.category_id
           ORDER BY total DESC
           LIMIT 10`,
        )
        .all(userId, thisMonth) as Array<{ name: string; total: number; count: number }>

      // 构建数据上下文
      const contextLines: string[] = ['用户财务数据摘要：']
      for (const row of summaryData) {
        const amount = (row.total / 100).toFixed(2)
        contextLines.push(`${row.month} ${row.type === 'expense' ? '支出' : '收入'}: ¥${amount}（${row.count}笔）`)
      }
      if (categorySummary.length > 0) {
        contextLines.push(`\n本月支出分类明细：`)
        for (const cat of categorySummary) {
          contextLines.push(`  ${cat.name}: ¥${(cat.total / 100).toFixed(2)}（${cat.count}笔）`)
        }
      }

      const dataContext = contextLines.join('\n')

      // 获取历史对话（最近10条）
      const history = db
        .prepare(
          `SELECT role, content FROM ai_conversations
           WHERE user_id = ? AND session_id = ?
           ORDER BY created_at ASC
           LIMIT 20`,
        )
        .all(userId, sessionId) as Array<{ role: string; content: string }>

      // 构建消息列表
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `你是一个个人财务分析助手。基于用户的交易数据回答财务相关问题。

## 数据上下文
${dataContext}

## 要求
1. 回答简洁，有数据支撑（具体金额、笔数、百分比）
2. 涉及对比时说明变化方向和幅度
3. 适当给出 1-2 条可操作的建议
4. 如果数据不足以回答，诚实说明
5. 用中文回答，金额用 ¥ 符号`,
        },
      ]

      // 加入历史对话
      for (const msg of history) {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
      }

      // 加入当前消息
      messages.push({ role: 'user', content: body.message })

      // 调用 LLM
      const aiResponse = await chatCompletion(messages, 0.7, 15000)

      // 存储对话记录
      const insertMsg = db.prepare(
        `INSERT INTO ai_conversations (user_id, session_id, role, content) VALUES (?, ?, ?, ?)`,
      )
      insertMsg.run(userId, sessionId, 'user', body.message)
      insertMsg.run(userId, sessionId, 'assistant', aiResponse)

      return {
        code: 0,
        data: {
          message: aiResponse,
          session_id: sessionId,
        },
        message: '',
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof AiError) {
        reply.code(502)
        return { code: 5003, data: null, message: err.message }
      }
      throw err
    }
  })

  // GET /api/ai/sessions - 对话列表
  app.get('/api/ai/sessions', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const sessions = db
      .prepare(
        `SELECT session_id, MIN(content) as first_message, MAX(created_at) as last_at, COUNT(*) as message_count
         FROM ai_conversations
         WHERE user_id = ? AND role = 'user'
         GROUP BY session_id
         ORDER BY last_at DESC
         LIMIT 50`,
      )
      .all(userId)

    return { code: 0, data: { items: sessions }, message: '' }
  })

  // DELETE /api/ai/sessions/:id - 删除对话
  app.delete('/api/ai/sessions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('DELETE FROM ai_conversations WHERE user_id = ? AND session_id = ?')
      .run(userId, id)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '对话不存在' }
    }

    return { code: 0, data: null, message: '对话已删除' }
  })
}


/**
 * 预清理输入文本，去除通知标题噪音
 */
function cleanInput(input: string): string {
  let text = input.trim()

  // 去除通知标题前缀（如 "[3条]动账通知"、"[招商银行]"）
  text = text.replace(/^\[?\d+条\]?\s*/g, '')
  text = text.replace(/^[\[【].*?[\]】]\s*/g, '')

  // 去除重复的标题（如 "动账通知 动账通知"）
  text = text.replace(/^(.{2,10})\s+\1\s*/g, '$1 ')

  // 去除开头的通知类关键词
  text = text.replace(/^(动账通知|交易提醒|消费提醒|收支通知)\s*/g, '')

  // 去除多余空白
  text = text.replace(/\s+/g, ' ').trim()

  return text || input.trim()
}
