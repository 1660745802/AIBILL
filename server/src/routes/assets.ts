/**
 * 资产管理路由 - /api/assets
 * 净资产概览、资产快照、趋势分析
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const updateAccountSchema = z.object({
  asset_type: z.enum(['liquid', 'savings', 'investment', 'credit', 'loan', 'property', 'other']).optional(),
  credit_limit: z.number().int().min(0).optional(),
  billing_day: z.number().int().min(0).max(31).optional(),
  due_day: z.number().int().min(0).max(31).optional(),
  note: z.string().max(500).optional(),
})

/** 计算单个账户的当前余额（分） */
function calcAccountBalance(db: any, userId: number, accountId: number): number {
  const income = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'income' AND account_id = ?
       AND status = 'confirmed' AND deleted_at IS NULL`
  ).get(userId, accountId) as { total: number }

  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'expense' AND account_id = ?
       AND status = 'confirmed' AND deleted_at IS NULL`
  ).get(userId, accountId) as { total: number }

  const transferIn = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'transfer' AND target_account_id = ?
       AND status = 'confirmed' AND deleted_at IS NULL`
  ).get(userId, accountId) as { total: number }

  const transferOut = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND type = 'transfer' AND account_id = ?
       AND status = 'confirmed' AND deleted_at IS NULL`
  ).get(userId, accountId) as { total: number }

  const account = db.prepare(
    'SELECT initial_balance FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, userId) as { initial_balance: number } | undefined

  const initial = account?.initial_balance || 0
  return initial + income.total - expense.total + transferIn.total - transferOut.total
}

export async function assetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/assets/overview - 资产全景概览
  app.get('/api/assets/overview', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    // 获取所有活跃账户
    const accounts = db.prepare(
      `SELECT id, name, type, icon, initial_balance, sort_order,
              asset_type, currency, credit_limit, billing_day, due_day, note
       FROM accounts WHERE user_id = ? AND is_active = 1
       ORDER BY sort_order, id`
    ).all(userId) as any[]

    let totalAssets = 0
    let totalLiabilities = 0
    const byType: Record<string, { total: number; count: number }> = {}

    const accountsWithBalance = accounts.map((acc: any) => {
      const balance = calcAccountBalance(db, userId, acc.id)
      const assetType = acc.asset_type || 'liquid'

      // 信用卡和贷款算负债
      if (assetType === 'credit' || assetType === 'loan') {
        // 对于信用卡：负余额 = 欠款（负债）
        if (balance < 0) {
          totalLiabilities += Math.abs(balance)
        } else {
          totalAssets += balance
        }
      } else {
        if (balance >= 0) {
          totalAssets += balance
        } else {
          totalLiabilities += Math.abs(balance)
        }
      }

      if (!byType[assetType]) {
        byType[assetType] = { total: 0, count: 0 }
      }
      byType[assetType].total += balance
      byType[assetType].count += 1

      return { ...acc, balance }
    })

    const netWorth = totalAssets - totalLiabilities

    const typeBreakdown = Object.entries(byType).map(([type, data]) => ({
      type,
      total: data.total,
      count: data.count,
    }))

    return {
      code: 0,
      data: {
        total_assets: totalAssets,
        total_liabilities: totalLiabilities,
        net_worth: netWorth,
        by_type: typeBreakdown,
        accounts: accountsWithBalance,
      },
      message: '',
    }
  })

  // GET /api/assets/trend?months=6 - 净资产趋势
  app.get('/api/assets/trend', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { months?: string }
    const months = Math.min(24, Math.max(1, parseInt(query.months || '6', 10)))

    // 获取最近 N 个月的快照数据
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)
    const startStr = startDate.toISOString().split('T')[0]

    const snapshots = db.prepare(
      `SELECT snapshot_date, SUM(balance) as net_worth
       FROM asset_snapshots
       WHERE user_id = ? AND snapshot_date >= ?
       GROUP BY snapshot_date
       ORDER BY snapshot_date`
    ).all(userId, startStr) as Array<{ snapshot_date: string; net_worth: number }>

    return { code: 0, data: { trend: snapshots, months }, message: '' }
  })

  // POST /api/assets/snapshot - 手动触发资产快照
  app.post('/api/assets/snapshot', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const today = new Date().toISOString().split('T')[0]

    const accounts = db.prepare(
      'SELECT id FROM accounts WHERE user_id = ? AND is_active = 1'
    ).all(userId) as Array<{ id: number }>

    let created = 0
    let skipped = 0

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO asset_snapshots (user_id, account_id, balance, snapshot_date, source)
       VALUES (?, ?, ?, ?, 'manual')`
    )

    const runSnapshot = db.transaction(() => {
      for (const acc of accounts) {
        const balance = calcAccountBalance(db, userId, acc.id)
        const result = insertStmt.run(userId, acc.id, balance, today)
        if (result.changes > 0) {
          created++
        } else {
          skipped++
        }
      }
    })

    runSnapshot()

    return {
      code: 0,
      data: { date: today, created, skipped, total: accounts.length },
      message: created > 0 ? `已记录 ${created} 个账户快照` : '今日快照已存在',
    }
  })

  // PUT /api/assets/accounts/:id - 更新账户资产属性
  app.put('/api/assets/accounts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateAccountSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 验证账户归属
      const account = db.prepare(
        'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
      ).get(Number(id), userId)

      if (!account) {
        reply.code(404)
        return { code: 3002, data: null, message: '账户不存在' }
      }

      // 动态构建 UPDATE 语句
      const updates: string[] = []
      const values: any[] = []

      if (body.asset_type !== undefined) { updates.push('asset_type = ?'); values.push(body.asset_type) }
      if (body.credit_limit !== undefined) { updates.push('credit_limit = ?'); values.push(body.credit_limit) }
      if (body.billing_day !== undefined) { updates.push('billing_day = ?'); values.push(body.billing_day) }
      if (body.due_day !== undefined) { updates.push('due_day = ?'); values.push(body.due_day) }
      if (body.note !== undefined) { updates.push('note = ?'); values.push(body.note) }

      if (updates.length === 0) {
        reply.code(400)
        return { code: 2000, data: null, message: '无更新字段' }
      }

      values.push(Number(id), userId)
      db.prepare(
        `UPDATE accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...values)

      return { code: 0, data: null, message: '账户已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })
}
