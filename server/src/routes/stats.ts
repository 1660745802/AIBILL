/**
 * 统计路由 - /api/stats
 * GET /api/stats/summary - 月度收支摘要
 * GET /api/stats/by-category - 分类排行
 * GET /api/stats/trend - 日/月趋势
 * GET /api/stats/dashboard - 仪表盘聚合数据
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { chatCompletion, AiError } from '../ai/client.js'
import { monthRange, prevMonthRange, today as todayStr, dateOffset } from '../lib/date.js'
import { budgetProgress, WARN_PERCENT } from '../lib/budget.js'
import { summarizeNetWorth } from '../lib/assets.js'

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/stats/summary - 月度收支摘要
  app.get('/api/stats/summary', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string }

    const now = new Date()
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)

    const { start: startDate, end: endDate } = monthRange(year, month)

    // 当月收支
    const result = db
      .prepare(
        `SELECT type, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, startDate, endDate) as Array<{ type: string; total: number; count: number }>

    let expense = 0, income = 0, expenseCount = 0, incomeCount = 0
    for (const row of result) {
      if (row.type === 'expense') { expense = row.total; expenseCount = row.count }
      if (row.type === 'income') { income = row.total; incomeCount = row.count }
    }

    // 上月数据（计算环比）
    const { start: prevStartDate, end: prevEndDate } = prevMonthRange(year, month)

    const prevResult = db
      .prepare(
        `SELECT type, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, prevStartDate, prevEndDate) as Array<{ type: string; total: number }>

    let prevExpense = 0, prevIncome = 0
    for (const row of prevResult) {
      if (row.type === 'expense') prevExpense = row.total
      if (row.type === 'income') prevIncome = row.total
    }

    return {
      code: 0,
      data: {
        year,
        month,
        expense,
        income,
        balance: income - expense,
        expense_count: expenseCount,
        income_count: incomeCount,
        prev_expense: prevExpense,
        prev_income: prevIncome,
        expense_change: prevExpense ? Math.round(((expense - prevExpense) / prevExpense) * 100) : null,
        income_change: prevIncome ? Math.round(((income - prevIncome) / prevIncome) * 100) : null,
      },
      message: '',
    }
  })

  // GET /api/stats/by-category - 分类排行
  app.get('/api/stats/by-category', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const query = request.query as { year?: string; month?: string; type?: string }

    const now = new Date()
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)
    const type = query.type || 'expense'

    const { start: startDate, end: endDate } = monthRange(year, month)

    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.icon, SUM(t.amount) as total, COUNT(*) as count
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
           AND t.type = ?
           AND t.date BETWEEN ? AND ?
         GROUP BY t.category_id
         ORDER BY total DESC`,
      )
      .all(userId, type, startDate, endDate) as Array<{
      id: number
      name: string
      icon: string
      total: number
      count: number
    }>

    // 计算总额和占比
    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0)
    const items = rows.map((r) => ({
      ...r,
      percent: grandTotal ? Math.round((r.total / grandTotal) * 1000) / 10 : 0,
    }))

    return {
      code: 0,
      data: { items, total: grandTotal, year, month, type },
      message: '',
    }
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

    const now = new Date()
    const type = query.type || 'expense'
    const period = query.period || 'daily'

    if (period === 'monthly') {
      // 月度趋势：最近12个月
      const year = parseInt(query.year || String(now.getFullYear()), 10)

      const rows = db
        .prepare(
          `SELECT
            substr(date, 1, 7) as month,
            SUM(amount) as total,
            COUNT(*) as count
           FROM transactions
           WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
             AND type = ?
             AND date >= ?
           GROUP BY substr(date, 1, 7)
           ORDER BY month ASC`,
        )
        .all(
          userId,
          type,
          `${year - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        ) as Array<{ month: string; total: number; count: number }>

      return { code: 0, data: { items: rows, period, type }, message: '' }
    }

    // 日趋势：指定月份每日数据
    const year = parseInt(query.year || String(now.getFullYear()), 10)
    const month = parseInt(query.month || String(now.getMonth() + 1), 10)
    const { start: startDate, end: endDate } = monthRange(year, month)
    const lastDay = Number(endDate.slice(8))

    const rows = db
      .prepare(
        `SELECT date, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type = ?
           AND date BETWEEN ? AND ?
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(userId, type, startDate, endDate) as Array<{ date: string; total: number; count: number }>

    // 补全空白日期
    const filled: Array<{ date: string; total: number; count: number }> = []
    const dataMap = new Map(rows.map((r) => [r.date, r]))
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      filled.push(dataMap.get(dateStr) || { date: dateStr, total: 0, count: 0 })
    }

    return { code: 0, data: { items: filled, period, type, year, month }, message: '' }
  })

  // GET /api/stats/dashboard - 仪表盘聚合数据
  app.get('/api/stats/dashboard', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1

    const { start: startDate, end: endDate } = monthRange(year, month)
    const today = todayStr()

    // === 1. 月度摘要 ===
    const summaryRows = db
      .prepare(
        `SELECT type, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, startDate, endDate) as Array<{ type: string; total: number; count: number }>

    let expense = 0, income = 0, transactionCount = 0
    for (const row of summaryRows) {
      if (row.type === 'expense') { expense = row.total; transactionCount += row.count }
      if (row.type === 'income') { income = row.total; transactionCount += row.count }
    }

    // 上月数据（环比）
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    const prevStartDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
    const prevLastDay = new Date(prevYear, prevMonth, 0).getDate()
    const prevEndDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`

    const prevRows = db
      .prepare(
        `SELECT type, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type IN ('expense', 'income')
           AND date BETWEEN ? AND ?
         GROUP BY type`,
      )
      .all(userId, prevStartDate, prevEndDate) as Array<{ type: string; total: number }>

    let prevExpense = 0, prevIncome = 0
    for (const row of prevRows) {
      if (row.type === 'expense') prevExpense = row.total
      if (row.type === 'income') prevIncome = row.total
    }

    const summary = {
      expense,
      income,
      balance: income - expense,
      expense_change: prevExpense ? Math.round(((expense - prevExpense) / prevExpense) * 100) : null,
      income_change: prevIncome ? Math.round(((income - prevIncome) / prevIncome) * 100) : null,
      transaction_count: transactionCount,
    }

    // === 2. 净资产（单条聚合 SQL，修复 N+1：原每账户 4 个相关子查询） ===
    const accounts = db
      .prepare(
        // 017：余额取 accounts.balance 权威列，不再「期初 + 流水」重算。
        // 重算会和手填覆盖打架，且 551/553 笔无归属流水让重算几乎恒等于期初值。
        `SELECT a.id, a.name, a.icon, a.asset_type, a.balance
        FROM accounts a
        WHERE a.user_id = ? AND a.is_active = 1
        ORDER BY a.sort_order ASC, a.id ASC`,
      )
      .all(userId) as Array<{ id: number; name: string; icon: string; asset_type: string; balance: number }>

    // 资产/负债/净资产口径与 /api/assets/overview 完全一致：见 lib/assets.ts
    // 净资产 = 所有账户余额之和 = 总资产 − 总负债
    const { total_assets, total_liabilities, net_worth: netWorthTotal } = summarizeNetWorth(accounts)
    const net_worth = { total: netWorthTotal, accounts }

    // === 2.1 资产分布（按 asset_type 分组）===
    // 直接复用上面已查出的 accounts 行在内存分组，不再重跑一遍同样的聚合
    const assetTypeMap: Record<string, { total: number; count: number }> = {}
    for (const acc of accounts) {
      const t = acc.asset_type || 'liquid'
      if (!assetTypeMap[t]) assetTypeMap[t] = { total: 0, count: 0 }
      assetTypeMap[t].total += acc.balance
      assetTypeMap[t].count += 1
    }
    const asset_breakdown = Object.entries(assetTypeMap).map(([type, v]) => ({
      type,
      total: v.total,
      count: v.count,
    }))

    // === 3. 7天支出趋势 ===
    const sevenDaysAgoStr = dateOffset(-6)

    const trendRows = db
      .prepare(
        `SELECT date, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
           AND type = 'expense'
           AND date BETWEEN ? AND ?
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(userId, sevenDaysAgoStr, today) as Array<{ date: string; total: number }>

    const trendMap = new Map(trendRows.map((r) => [r.date, r.total]))
    const trend_7days: Array<{ date: string; total: number }> = []
    for (let i = 0; i < 7; i++) {
      const dateStr = dateOffset(-6 + i)
      trend_7days.push({ date: dateStr, total: trendMap.get(dateStr) || 0 })
    }

    // === 4. 当月分类支出 Top5 ===
    const categoryRows = db
      .prepare(
        `SELECT c.name, c.icon, SUM(t.amount) as total
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
           AND t.type = 'expense'
           AND t.date BETWEEN ? AND ?
         GROUP BY t.category_id
         ORDER BY total DESC
         LIMIT 5`,
      )
      .all(userId, startDate, endDate) as Array<{ name: string; icon: string; total: number }>

    const categoryTotal = categoryRows.reduce((sum, r) => sum + r.total, 0)
    const top_categories = categoryRows.map((r) => ({
      name: r.name,
      icon: r.icon,
      total: r.total,
      percent: categoryTotal ? Math.round((r.total / categoryTotal) * 1000) / 10 : 0,
    }))

    // === 5. 预算进度 ===
    const budgetRows = db
      .prepare(
        `SELECT b.id, b.category_id, b.amount, c.name as category_name, c.icon as category_icon
         FROM budgets b
         LEFT JOIN categories c ON b.category_id = c.id AND b.category_id != 0
         WHERE b.user_id = ? AND b.year = ? AND (b.month = ? OR b.month = 0)
         ORDER BY b.category_id`,
      )
      .all(userId, year, month) as Array<{
      id: number
      category_id: number
      amount: number
      category_name: string | null
      category_icon: string | null
    }>

    // Pre-fetch all category spending in one query (avoids N+1)
    const spentByCategory = db
      .prepare(
        `SELECT category_id, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND type = 'expense'
           AND status = 'confirmed' AND deleted_at IS NULL
           AND date BETWEEN ? AND ?
         GROUP BY category_id`,
      )
      .all(userId, startDate, endDate) as Array<{ category_id: number; total: number }>

    const totalExpenseForBudget = spentByCategory.reduce((sum, r) => sum + r.total, 0)
    const spentMap = new Map(spentByCategory.map((r) => [r.category_id, r.total]))

    const budget_progress = budgetRows.map((b) => {
      // Use pre-fetched category spending data (single batch query)
      const spent = b.category_id === 0 ? totalExpenseForBudget : (spentMap.get(b.category_id) || 0)
      const { percent, status, remaining } = budgetProgress(spent, b.amount)

      return {
        category_name: b.category_id === 0 ? '总预算' : (b.category_name || '未知'),
        category_icon: b.category_id === 0 ? '💰' : (b.category_icon || '📦'),
        amount: b.amount,
        spent,
        percent,
        status,
        remaining,
      }
    })

    // === 6. 异常提醒 ===
    const alerts: Array<{ type: string; message: string; data?: any }> = []

    // 6a. large_expense: 今日单笔 > 日均支出 * 5
    const avgDailyResult = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total, COUNT(DISTINCT date) as days
         FROM transactions
         WHERE user_id = ? AND type = 'expense'
           AND status = 'confirmed' AND deleted_at IS NULL
           AND date BETWEEN ? AND ?`,
      )
      .get(userId, startDate, endDate) as { total: number; days: number }

    const avgDaily = avgDailyResult.days > 0 ? avgDailyResult.total / avgDailyResult.days : 0

    if (avgDaily > 0) {
      const largeToday = db
        .prepare(
          `SELECT id, amount, description
           FROM transactions
           WHERE user_id = ? AND type = 'expense'
             AND status = 'confirmed' AND deleted_at IS NULL
             AND date = ?
             AND amount > ?
           ORDER BY amount DESC
           LIMIT 3`,
        )
        .all(userId, today, avgDaily * 5) as Array<{ id: number; amount: number; description: string | null }>

      for (const tx of largeToday) {
        alerts.push({
          type: 'large_expense',
          message: `今日大额支出：${tx.description || '未备注'} ¥${(tx.amount / 100).toFixed(2)}，超过日均${Math.round(tx.amount / avgDaily)}倍`,
          data: { transaction_id: tx.id, amount: tx.amount },
        })
      }
    }

    // 6b. budget_warning: 预算使用超过阈值
    for (const bp of budget_progress) {
      if (bp.percent >= WARN_PERCENT) {
        alerts.push({
          type: 'budget_warning',
          message: `${bp.category_name}预算已使用${bp.percent}%${bp.status === 'exceeded' ? '，已超支！' : '，请注意控制'}`,
          data: { category_name: bp.category_name, percent: bp.percent, status: bp.status },
        })
      }
    }

    // === 7. 最近流水(5笔) ===
    const recent_transactions = db
      .prepare(
        `SELECT t.id, t.type, t.amount, t.description, t.date, t.time,
                c.name as category_name, c.icon as category_icon,
                a.name as account_name, a.icon as account_icon
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
         ORDER BY t.date DESC, t.created_at DESC
         LIMIT 5`,
      )
      .all(userId)

    // === 8. 订阅到期提醒 ===
    const todayStrLocal = todayStr()
    const in7days = dateOffset(7)
    const upcomingSubs = db
      .prepare(
        `SELECT name, amount, next_payment_date FROM subscriptions
         WHERE user_id = ? AND status = 'active'
           AND next_payment_date IS NOT NULL
           AND next_payment_date BETWEEN ? AND ?
         ORDER BY next_payment_date ASC
         LIMIT 5`,
      )
      .all(userId, todayStrLocal, in7days) as Array<{ name: string; amount: number; next_payment_date: string }>

    for (const sub of upcomingSubs) {
      const daysLeft = Math.ceil((new Date(sub.next_payment_date).getTime() - Date.now()) / 86400000)
      const dayText = daysLeft <= 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft}天后`
      alerts.push({
        type: 'subscription_due',
        message: `${sub.name} ${dayText}扣费 ¥${(sub.amount / 100).toFixed(2)}`,
      })
    }

    // === 9. 储蓄率（本月收入 - 支出 / 收入） ===
    const saving_rate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0

    // === 10. 活跃目标（Top 3） ===
    const goalsRows = db
      .prepare(
        `SELECT id, name, icon, target_amount, current_amount, type, deadline, priority, monthly_contribution
         FROM financial_goals
         WHERE user_id = ? AND status = 'active'
         ORDER BY priority ASC, created_at DESC
         LIMIT 3`,
      )
      .all(userId) as Array<{
        id: number
        name: string
        icon: string
        target_amount: number
        current_amount: number
        type: string
        deadline: string | null
        priority: number
        monthly_contribution: number
      }>

    const goals_top = goalsRows.map((g) => {
      const percent = g.target_amount > 0
        ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100))
        : 0
      const remaining = Math.max(0, g.target_amount - g.current_amount)
      let estimated_completion: string | null = null
      if (g.monthly_contribution > 0 && remaining > 0) {
        const monthsLeft = Math.ceil(remaining / g.monthly_contribution)
        const est = new Date()
        est.setMonth(est.getMonth() + monthsLeft)
        estimated_completion = est.toISOString().split('T')[0]
      }
      return {
        id: g.id,
        name: g.name,
        icon: g.icon,
        target_amount: g.target_amount,
        current_amount: g.current_amount,
        percent,
        remaining,
        deadline: g.deadline,
        estimated_completion,
      }
    })

    // === 11. 订阅概览（活跃订阅 + 月费折算） ===
    const subStats = db
      .prepare(
        `SELECT COUNT(*) as count,
                SUM(CASE WHEN cycle='monthly' THEN amount ELSE 0 END) as monthly_total,
                SUM(CASE WHEN cycle='yearly' THEN amount / 12.0 ELSE 0 END) as monthly_yearly_equiv,
                SUM(CASE WHEN cycle='quarterly' THEN amount / 3.0 ELSE 0 END) as monthly_quarterly_equiv
         FROM subscriptions
         WHERE user_id = ? AND status = 'active'`,
      )
      .get(userId) as { count: number; monthly_total: number; monthly_yearly_equiv: number; monthly_quarterly_equiv: number }
    const subscriptions_overview = {
      active_count: subStats.count || 0,
      monthly_total: Math.round((subStats.monthly_total || 0) + (subStats.monthly_yearly_equiv || 0) + (subStats.monthly_quarterly_equiv || 0)),
      yearly_total: Math.round(((subStats.monthly_total || 0) + (subStats.monthly_yearly_equiv || 0) + (subStats.monthly_quarterly_equiv || 0)) * 12),
    }

    return {
      code: 0,
      data: {
        summary: { ...summary, saving_rate },
        net_worth,
        total_assets,
        total_liabilities,
        asset_breakdown,
        trend_7days,
        top_categories,
        budget_progress,
        alerts,
        recent_transactions,
        goals_top,
        subscriptions_overview,
      },
    }
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

      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() + 1

      // 收集近 4 个月数据（单条 GROUP BY 查询，原 4 次循环已合并）
      const monthsData = new Map<string, { expense: number; income: number }>()
      for (let i = 0; i < 4; i++) {
        const m = month - i <= 0 ? month - i + 12 : month - i
        const y = month - i <= 0 ? year - 1 : year
        const ms = `${y}-${String(m).padStart(2, '0')}`
        monthsData.set(ms, { expense: 0, income: 0 })
      }
      const earliestKey = [...monthsData.keys()].sort()[0]
      const rows = db
        .prepare(
          `SELECT substr(date, 1, 7) AS ym, type, SUM(amount) AS total
           FROM transactions
           WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
             AND type IN ('expense', 'income')
             AND substr(date, 1, 7) >= ?
           GROUP BY ym, type`,
        )
        .all(userId, earliestKey) as Array<{ ym: string; type: string; total: number }>
      for (const r of rows) {
        const slot = monthsData.get(r.ym)
        if (!slot) continue
        if (r.type === 'expense') slot.expense = r.total
        else if (r.type === 'income') slot.income = r.total
      }
      const months = [...monthsData.entries()].map(([month, v]) => ({
        month,
        expense: v.expense,
        income: v.income,
      }))

      // 当月分类明细
      const { start: thisStart, end: thisEnd } = monthRange(year, month)

      const categories = db
        .prepare(
          `SELECT c.name, c.icon, SUM(t.amount) as total
           FROM transactions t JOIN categories c ON t.category_id = c.id
           WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
             AND t.type = 'expense' AND t.date BETWEEN ? AND ?
           GROUP BY t.category_id ORDER BY total DESC LIMIT 10`,
        )
        .all(userId, thisStart, thisEnd) as Array<{ name: string; icon: string; total: number }>

      // 净资产（单条聚合 SQL，修复 N+1）
      const netWorthRow = db
        .prepare(
          // 017：同上，权威列
        `SELECT COALESCE(SUM(a.balance), 0) AS total
          FROM accounts a
          WHERE a.user_id = ? AND a.is_active = 1`,
        )
        .get(userId) as { total: number } | undefined
      const netWorth = netWorthRow?.total ?? 0

      // 订阅月支出
      const subRow = db
        .prepare(
          `SELECT SUM(CASE
            WHEN cycle = 'monthly' THEN amount
            WHEN cycle = 'quarterly' THEN amount / 3
            WHEN cycle = 'yearly' THEN amount / 12
           END) as monthly_total
           FROM subscriptions WHERE user_id = ? AND status = 'active'`,
        )
        .get(userId) as { monthly_total: number | null } | undefined
      const subscriptionMonthly = subRow?.monthly_total || 0

      // 预算
      const budgets = db
        .prepare(
          `SELECT b.amount, b.category_id, c.name as category_name
           FROM budgets b LEFT JOIN categories c ON b.category_id = c.id AND b.category_id != 0
           WHERE b.user_id = ? AND b.year = ? AND (b.month = ? OR b.month = 0)`,
        )
        .all(userId, year, month) as Array<{ amount: number; category_id: number; category_name: string | null }>

      // 构建数据文本
      const dataLines: string[] = []
      dataLines.push('## 近4个月收支')
      for (const m of months) {
        dataLines.push(`${m.month}: 支出¥${(m.expense / 100).toFixed(0)} 收入¥${(m.income / 100).toFixed(0)}`)
      }

      if (categories.length > 0) {
        dataLines.push('\n## 本月支出分类')
        const totalExp = categories.reduce((s, c) => s + c.total, 0)
        for (const c of categories) {
          const pct = totalExp > 0 ? Math.round((c.total / totalExp) * 100) : 0
          dataLines.push(`${c.name}: ¥${(c.total / 100).toFixed(0)} (${pct}%)`)
        }
      }

      dataLines.push(`\n## 资产概况`)
      dataLines.push(`净资产: ¥${(netWorth / 100).toFixed(0)}`)
      if (subscriptionMonthly > 0) {
        dataLines.push(`固定订阅月支出: ¥${(subscriptionMonthly / 100).toFixed(0)}`)
      }

      if (budgets.length > 0) {
        dataLines.push('\n## 预算设置')
        for (const b of budgets) {
          const name = b.category_id === 0 ? '总预算' : (b.category_name || '分类预算')
          dataLines.push(`${name}: ¥${(b.amount / 100).toFixed(0)}/月`)
        }
      }

      const dataText = dataLines.join('\n')

      // 构建 prompt
      const prompts: Record<string, string> = {
        overview: `你是个人财务分析师。基于以下财务数据，给出全面的财务健康分析。

${dataText}

## 要求
分3段输出：
1. 📊 财务概况（2-3句话总结当前状况）
2. 💡 关键发现（3-5个要点，每个一句话，带数据支撑）
3. ✅ 行动建议（2-3条具体可执行的建议）

用中文回答，金额用¥符号，百分比保留整数。简洁有力，不要废话。`,

        spending: `你是消费行为分析师。基于以下数据分析用户的消费模式和优化空间。

${dataText}

## 要求
分3段：
1. 🔍 消费结构（各分类占比分析，是否合理）
2. 📈 变化趋势（与上月对比，哪些增/减/异常）
3. 💰 节省空间（具体指出可以优化的地方和金额估算）

用中文。`,

        forecast: `你是财务规划师。基于以下历史数据预测未来趋势。

${dataText}

## 要求
分3段：
1. 📅 本月预测（按当前趋势本月最终支出预估）
2. 🎯 预算评估（是否能达标，哪些分类有风险）
3. 🗓️ 3个月展望（基于趋势给出中期建议）

用中文，预测数字给出区间。`,
      }

      const aiResponse = await chatCompletion(
        [
          { role: 'system', content: prompts[body.type] },
          { role: 'user', content: '请分析' },
        ],
        0.7,
        30000,
      )

      return {
        code: 0,
        data: {
          type: body.type,
          analysis: aiResponse,
          data_summary: {
            months,
            categories: categories.map((c) => ({ name: c.name, icon: c.icon, total: c.total })),
            net_worth: netWorth,
            subscription_monthly: subscriptionMonthly,
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
