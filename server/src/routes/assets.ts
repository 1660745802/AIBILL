/**
 * 资产管理路由 - /api/assets
 * 净资产概览、资产快照、趋势分析
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { summarizeNetWorth } from '../lib/assets.js'
import { buildPortfolio, type AccountRow, type SnapshotPoint } from '../lib/portfolio.js'
import { loadAccountHoldings } from '../lib/investments-repo.js'
import { setManualBalance, recordBalanceSamples } from '../lib/account-balance.js'

const updateAccountSchema = z.object({
  asset_type: z.enum(['liquid', 'savings', 'investment', 'credit', 'loan', 'property', 'other']).optional(),
  /**
   * 账户级总投入（分）——理财账户专用，只在存钱/取钱时改。
   * 加减仓**不改它**（买卖不改变"一共投进去多少"）。允许负数（取出的比投的多）。
   */
  invested_total: z.number().int().nullish(),
  credit_limit: z.number().int().min(0).optional(),
  billing_day: z.number().int().min(0).max(31).optional(),
  due_day: z.number().int().min(0).max(31).optional(),
  note: z.string().max(500).optional(),
})

/**
 * 一次性取该用户所有活跃账户的**权威余额**（分），返回 account_id → balance 映射。
 *
 * 017 之后余额不再每次重算：`accounts.balance` 就是唯一真源，由
 *   - 有归属的账单增删改 → 增量加减（lib/account-balance.ts）
 *   - 手填               → 覆盖
 * 两条路径共同维护。
 *
 * 旧版这里是「期初余额 + 流水重算」，它和手填快照两个来源会打架：仪表读一个数、
 * 账户页读另一个数。而且 551/553 笔流水没有 account_id，重算几乎恒等于期初余额。
 * 修 N+1 的写法保留（1 次聚合查询）。
 */
function calcAccountBalances(db: any, userId: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT id AS account_id, balance
     FROM accounts
     WHERE user_id = ? AND is_active = 1`,
  ).all(userId) as Array<{ account_id: number; balance: number }>

  return new Map(rows.map((r) => [r.account_id, r.balance]))
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

    const byType: Record<string, { total: number; count: number }> = {}

    // 单条聚合 SQL 取所有账户余额（修复 N+1）
    const balances = calcAccountBalances(db, userId)

    // 口径：负余额 = 负债（信用卡欠款、活期透支都算），正余额 = 资产。
    // asset_type 只用于展示分组。与 /api/stats/dashboard 共用 summarizeNetWorth。
    const accountsWithBalance = accounts.map((acc: any) => {
      const balance = balances.get(acc.id) ?? 0
      const assetType = acc.asset_type || 'liquid'

      if (!byType[assetType]) {
        byType[assetType] = { total: 0, count: 0 }
      }
      byType[assetType].total += balance
      byType[assetType].count += 1

      return { ...acc, balance }
    })

    const { total_assets: totalAssets, total_liabilities: totalLiabilities, net_worth: netWorth } =
      summarizeNetWorth(accountsWithBalance)

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

    /**
     * **跳过理财账户。**
     *
     * 新读模型把 `balance` 当**现金**读（持仓市值另外算），对理财账户写入
     * 「总价值」语义会造成双重计算——踩中 UI-DESIGN §6.6 硬规则 1。
     * 理财账户的现金由「各账户余额 / 投资页」手动记。
     * 这个端点为已发布的 Android 客户端保留，所以不删，只把理财账户排除掉。
     *
     * 017 之后不再回算：直接把 `accounts.balance` 这个权威值落一行快照。
     *
     * 写入本身（插行 + 推进基线 + 计数 + 事务）全部在 account-balance module 里。
     * 本路由只决定**记哪些账户**——筛选口径属于这个端点的策略。
     * 别把这里换算成 `setManualBalance`：那会变成「覆盖 + 无条件推进基线」，
     * 同一天第二次点就会把两次之间新建的账单烤进余额，之后改它们会被静默忽略。
     * 两个函数看起来像，其实语义不同，理由见 recordBalanceSamples 的注释。
     */
    const accounts = db.prepare(
      `SELECT id FROM accounts
        WHERE user_id = ? AND is_active = 1 AND COALESCE(asset_type, 'liquid') <> 'investment'`
    ).all(userId) as Array<{ id: number }>

    // 单条聚合 SQL 取所有账户余额（修复 N+1）
    const balances = calcAccountBalances(db, userId)

    // 只记活跃、非理财的账户；它们的余额就是当前的权威值。
    const toSample = new Map<number, number>(
      accounts.map((a) => [a.id, balances.get(a.id) ?? 0]),
    )

    const { date, created, skipped, total } = recordBalanceSamples(db, userId, toSample)

    return {
      code: 0,
      data: { date, created, skipped, total },
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
      if (body.invested_total !== undefined) { updates.push('invested_total = ?'); values.push(body.invested_total) }
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
  /* ══════════════════════════════════════════════════════
     手动快照：证券/资产工作台的核心写入路径

     为什么不从流水回算：551/553 笔交易没有 account_id，回算余额必然是错的
     （实测算出来每个账户都是 0）。既然回算不可靠，就直接记「某天值多少」。
     ══════════════════════════════════════════════════════ */

  /**
   * 手动快照只记**现金余额**（分）。
   *
   * 份额按标的记在 `investments.quantity`（投资页维护）；
   * 总投入是账户属性，记在 `accounts.invested_total`（投资页维护）。
   * 曾经这两个也塞在快照里，导致同一份数据有两个写入口，迟早写错一边。
   */
  const manualSnapshotSchema = z.object({
    /** 留空表示今天。允许补录——快照是采样不是流水，漏几天随时补 */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    items: z.array(z.object({
      account_id: z.number().int().positive(),
      /** 现金/余额，单位分。负数 = 负债（信用卡欠款），是合法值 */
      balance: z.number().int(),
    })).min(1).max(50),
  })

  /**
   * 行源：每个活跃账户一行（不管有没有填过余额）。
   *
   * 「想填就填，不想填就是 0」——所以没填过的账户也必须在这里，
   * 否则它既进不了净资产、页面上也没处填。
   * 停用账户（软删）要排除：它的快照还在库里，留着会让最后一笔现金
   * 永远留在净资产里，也会让「日变动」因覆盖数永不相等而恒为 null。
   */
  function readAccounts(db: ReturnType<typeof getDb>, userId: number): AccountRow[] {
    return db.prepare(
      `SELECT a.id AS account_id, a.name AS account_name, a.asset_type, a.invested_total,
              a.balance
         FROM accounts a
        WHERE a.user_id = ? AND a.is_active = 1
        ORDER BY a.sort_order ASC, a.id ASC`,
    ).all(userId) as AccountRow[]
  }

  /** 曲线源：快照历史（每账户每天一条）。和行源是两个问题，分开读 */
  function readHistory(db: ReturnType<typeof getDb>, userId: number, sinceDays = 3650): SnapshotPoint[] {
    const since = new Date(Date.now() - sinceDays * 86400000)
      .toISOString().slice(0, 10)
    return db.prepare(
      `SELECT s.account_id, s.snapshot_date, s.balance
         FROM asset_snapshots s
         JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ? AND a.is_active = 1 AND s.snapshot_date >= ?
        ORDER BY s.snapshot_date ASC`,
    ).all(userId, since) as SnapshotPoint[]
  }

  function countAccounts(db: ReturnType<typeof getDb>, userId: number): number {
    return (db.prepare(
      'SELECT count(*) c FROM accounts WHERE user_id = ? AND is_active = 1',
    ).get(userId) as { c: number }).c
  }

  /**
   * 构建「每账户持仓估值」映射，喂给 buildPortfolio。
   *
   * 持仓市值 = Σ(股数 × 单价)，单价取每个标的**最新一条**行情（quote_date 最大，
   * 同日取 quoted_at 最大）。某标的取不到行情时该账户 marketValue=null——
   * 不拿部分之和冒充完整市值。
   *
   * 挂了持仓（investments 里有该账户的 active 记录）的账户，才会出现在返回的 Map 里；
   * buildPortfolio 据此把这些账户的 asset_snapshots.balance 当「现金」处理。
   */
  /**
   * GET /api/assets/portfolio — 工作台读模型
   * 净资产 / 各账户最新快照 / 投资浮盈 / 净值曲线（含每日覆盖率）
   */
  app.get('/api/assets/portfolio', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId
    const today = new Date().toISOString().slice(0, 10)
    const portfolio = buildPortfolio(
      readAccounts(db, userId),
      readHistory(db, userId),
      countAccounts(db, userId),
      today,
      loadAccountHoldings(db, userId),
    )
    return { code: 0, data: portfolio, message: '' }
  })

  /**
   * PUT /api/assets/snapshots — 写入/覆盖某一天的快照
   * 用 UPSERT：同一天同一账户重复提交是覆盖而不是报错（手动录入很常见地会重填）
   */
  app.put('/api/assets/snapshots', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = manualSnapshotSchema.safeParse(request.body)
    if (!body.success) {
      reply.code(400)
      return { code: 2000, data: null, message: body.error.errors[0]!.message }
    }
    const db = getDb()
    const userId = request.user!.userId
    const date = body.data.date ?? new Date().toISOString().slice(0, 10)

    // 账户归属校验：不能给别人的账户写快照
    const owned = new Set(
      (db.prepare('SELECT id FROM accounts WHERE user_id = ? AND is_active = 1')
        .all(userId) as Array<{ id: number }>).map((r) => r.id),
    )
    const foreign = body.data.items.find((i) => !owned.has(i.account_id))
    if (foreign) {
      reply.code(400)
      return { code: 2001, data: null, message: `账户 ${foreign.account_id} 不存在或不属于当前用户` }
    }

    // 快照行由 setManualBalance() 统一写入（upsert），这里不再重复写一遍。
    const run = db.transaction(() => {
      for (const item of body.data.items) {
        // 手填 = **覆盖**余额，并把基准线刷到此刻。
        //
        // ⚠️ 基准线不能用用户选的 `date`：`date` 可补录到过去，基准线一旦倒退，
        // 会把「那天之后、今天之前」已生效的账单效果抹掉，而那些账单又仍被判为
        // 「基准线之外」——删掉还会再减一次。基准线只前进，date 只用于快照行日期。
        setManualBalance(db, userId, item.account_id, item.balance, { date })
      }
    })
    run()

    const portfolio = buildPortfolio(
      readAccounts(db, userId),
      readHistory(db, userId),
      countAccounts(db, userId),
      new Date().toISOString().slice(0, 10),
      loadAccountHoldings(db, userId),
    )
    return {
      code: 0,
      data: { date, saved: body.data.items.length, portfolio },
      message: `已记录 ${body.data.items.length} 个账户的 ${date} 快照`,
    }
  })

}

