/**
 * AI 路由 - /api/ai
 * POST /api/ai/parse - AI 记账解析
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
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

      // 调用 LLM
      const aiResponse = await chatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.input },
        ],
        0.1,
        10000,
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
}
