/**
 * 资产管理路由 - /api/assets
 *
 * 提供两类东西：
 *   - 账户元数据（`/overview`）与账户资产属性（`/assets/accounts/:id`）
 *   - 净资产读模型（`/portfolio`）与手填快照（`/snapshots`）
 *
 * 净资产 / 负债 / 构成的**唯一**真源是 `/api/assets/portfolio`，计算在
 * `lib/portfolio.ts`。趋势（`/assets/trend`）与旧采样端点（`POST /assets/snapshot`）
 * 已于 2026-10 删除。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { buildPortfolio, readAccounts, readHistory, countAccounts } from '../lib/portfolio.js'
import { today as todayStr } from '../lib/date.js'
import { loadAccountHoldings } from '../lib/investments-repo.js'
import { setManualBalance, BalanceWriteRejected } from '../lib/account-balance.js'

const updateAccountSchema = z.object({
  asset_type: z.enum(['liquid', 'savings', 'investment', 'credit', 'loan', 'property', 'other']).optional(),
  /**
   * 账户级总投入（分）——理财账户专用，只在存钱/取钱时改。
   * 加减仓**不改它**（买卖不改变"一共投进去多少"）。允许负数（取出的比投的多）。
   *
   * `.safe()`：`int()` 放过 1e20 这种非安全整数，而 SQLite 的 INTEGER 列
   * 照样会把它存成 REAL（实测 typeof='real'）——总投入是「整数分」口径，
   * 变成浮点后浮盈跟着带误差。
   */
  invested_total: z.number().int().safe().nullish(),
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
  //
  // 只提供**账户元数据 + 每账户现金余额**，不再提供任何净资产口径的字段。
  // 净资产/总负债/资产构成只有一个真源：`GET /api/assets/portfolio`。
  // 曾经这里还返回 `total_assets` / `total_liabilities` / `net_worth` / `by_type`，
  // 且是**现金口径**（不含持仓市值），而仪表读的是 portfolio 的总价值口径——
  // 同一个数字两套算法，正是这个项目大半历史 bug 的来源。已删除。
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

    // 单条聚合 SQL 取所有账户余额（修复 N+1）
    const balances = calcAccountBalances(db, userId)

    // `balance` 是**现金**（`accounts.balance`），不是账户总价值——
    // 理财账户还要加持仓市值，那部分在 portfolio 里算。
    const accountsWithBalance = accounts.map((acc: any) => ({
      ...acc,
      balance: balances.get(acc.id) ?? 0,
    }))

    return {
      code: 0,
      data: {
        accounts: accountsWithBalance,
      },
      message: '',
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
      /**
       * 现金/余额，单位分。负数 = 负债（信用卡欠款），是合法值。
       * `.safe()`：非安全整数（1e20）会被 SQLite 存成 REAL，净资产从此带浮点误差。
       */
      balance: z.number().int().safe(),
    })).min(1).max(50),
  })

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
    const today = todayStr()
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
    const date = body.data.date ?? todayStr()

    /**
     * 归属与活跃态校验**由 module 统一承担**（`setManualBalance` 抛
     * `BalanceWriteRejected`），路由不再重复查一遍——之前这里有一道带
     * `is_active = 1` 的前置守卫，与 module 的检查重复，且它的 message
     * 是「不存在或不属于当前用户」，对**停用**账户来说是撒谎（两条入口文案不一致）。
     * 审查 MAJOR-3：若日后有人删掉那道守卫，新错误类型无人接 ⇒ 同一条件直接 500。
     *
     * 删掉它同时省掉一次全表查询。校验仍在事务内、逐账户、整批同生共死。
     */
    try {
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
    } catch (err) {
      if (err instanceof BalanceWriteRejected) {
        reply.code(400)
        return { code: 2001, data: null, message: err.message }
      }
      throw err
    }

    const portfolio = buildPortfolio(
      readAccounts(db, userId),
      readHistory(db, userId),
      countAccounts(db, userId),
      todayStr(),
      loadAccountHoldings(db, userId),
    )
    return {
      code: 0,
      data: { date, saved: body.data.items.length, portfolio },
      message: `已记录 ${body.data.items.length} 个账户的 ${date} 快照`,
    }
  })

}

