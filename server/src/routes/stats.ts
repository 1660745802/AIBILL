/**
 * 统计路由 - /api/stats
 * GET /api/stats/summary - 月度收支摘要
 * GET /api/stats/by-category - 分类排行
 * GET /api/stats/trend - 日/月趋势
 * GET /api/stats/dashboard - 仪表盘聚合数据
 * POST /api/stats/analysis - AI 财务分析
 *
 * **薄路由**：只做「解析参数 + 调 `lib/stats/*` 读模型 + 拼 `code/message`」。
 * SQL、环比/占比/预算/预警口径全部在读模型里（C5）。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { chatCompletion, AiError } from '../ai/client.js'
import { buildStatsSummary } from '../lib/stats/summary.js'
import { buildByCategory } from '../lib/stats/by-category.js'
import { buildTrend } from '../lib/stats/trend.js'
import { buildDashboard } from '../lib/stats/dashboard.js'
import { buildAnalysisContext } from '../lib/stats/analysis.js'

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/stats/summary - 月度收支摘要
  app.get('/api/stats/summary', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string }

    return { code: 0, data: buildStatsSummary(db, userId, query), message: '' }
  })

  // GET /api/stats/by-category - 分类排行
  app.get('/api/stats/by-category', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string; type?: string }

    return { code: 0, data: buildByCategory(db, userId, query), message: '' }
  })

  // GET /api/stats/trend - 日/月趋势
  app.get('/api/stats/trend', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as {
      year?: string
      month?: string
      period?: string // 'daily' | 'monthly'
      type?: string
    }

    return { code: 0, data: buildTrend(db, userId, query), message: '' }
  })

  // GET /api/stats/dashboard - 仪表盘聚合数据
  app.get('/api/stats/dashboard', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    return { code: 0, data: buildDashboard(db, userId) }
  })

  // POST /api/stats/analysis - AI 财务分析
  const analysisSchema = z.object({
    type: z.enum(['overview', 'spending', 'forecast']),
  })

  app.post('/api/stats/analysis', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = analysisSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 数据采集 + 喂给模型的文本（含 <user_data> 注入护栏）都在读模型里
      const ctx = buildAnalysisContext(db, userId)

      const aiResponse = await chatCompletion(
        [
          { role: 'system', content: ctx.prompts[body.type] },
          { role: 'user', content: '请分析' },
        ],
        0.7,
        30000,
        userId,
      )

      return {
        code: 0,
        data: {
          type: body.type,
          analysis: aiResponse,
          data_summary: {
            months: ctx.months,
            categories: ctx.categories.map((c) => ({ name: c.name, icon: c.icon, total: c.total })),
            net_worth: ctx.netWorth,
            /**
             * `net_worth` 是**总价值**（现金 + 持仓市值），与仪表逐分相同。
             * 行情缺失的账户只计入现金 → 它可能是**下界**，必须配下两个字段读。
             */
            net_worth_complete: ctx.netWorthComplete,
            unpriced_accounts: ctx.unpricedAccounts,
            subscription_monthly: ctx.subscriptionMonthly,
          },
          generated_at: new Date().toISOString(),
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
}
