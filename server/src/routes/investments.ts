/**
 * 持仓路由 - /api/investments
 *
 * 只管**持仓本身**（代码 + 股数）：增删改查 + 逐条市值。
 *
 * **不在这里算盈亏。** 账户级读数（市值/现金/总投入/浮盈）统一由
 * `GET /api/assets/portfolio` 出（见 lib/portfolio.ts），投资页复用它。
 * 两处各算一遍同一个浮盈，迟早会漂移——这是真实踩过的坑
 * （同一屏上「头条 +14,170 / 持仓行 −13,830」符号打架）。
 *
 * 单只不记成本：用户明确「投入不要针对单只持仓股，计算总投入就可以」。
 *
 * code 一律走 lib/quotes.ts 的 normalizeCode，不另写一套：
 * 用户可以填 518880 / sh518880 / 518880.SH，统一规范成 sh518880。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { normalizeCode, fetchQuotes, currencyOf, fxCodesFor, type Quote } from '../lib/quotes.js'
import { storeQuotes, loadLatestFxRates } from '../lib/investments-repo.js'
import { fetchFxRates } from '../lib/fx.js'
import { shouldFetchQuotes } from '../services/scheduler.js'
import { loadValuedHoldings } from '../lib/investments-repo.js'

const createSchema = z.object({
  account_id: z.number().int().positive(),
  /** 原始输入，支持 518880 / sh518880 / 518880.SH；后端 normalize */
  code: z.string().min(1).max(32),
  name: z.string().max(50).nullish(),
  kind: z.enum(['etf', 'stock', 'fund', 'gold_gram']).optional().default('etf'),
  /** 份额/股数；gold_gram 为克数。允许 0（清仓后留档） */
  quantity: z.number().nonnegative(),
  note: z.string().max(200).nullish(),
})

const updateSchema = z.object({
  name: z.string().max(50).nullish(),
  quantity: z.number().nonnegative().optional(),
  note: z.string().max(200).nullish(),
})

interface InvestmentRow {
  id: number
  account_id: number
  code: string
  name: string | null
  market: string | null
  kind: string
  quantity: number
  note: string | null
  is_active: number
  updated_at: string
}

/** 518880.SH / sh518880 / 518880 → normalizeCode 认得的形式（先剥掉 .XX 后缀） */
function normalizeInput(raw: string): string {
  const s = raw.trim()
  // 兼容 "518880.SH" / "00700.HK" 这类带点后缀的写法
  const m = s.match(/^(\d{4,6})\.([a-zA-Z]{2})$/)
  if (m) {
    const [, num, mk] = m
    return normalizeCode(`${mk!.toLowerCase()}${num}`)
  }
  return normalizeCode(s)
}

/** market 前缀从规范化 code 里拆出来：sh518880 → sh；hf_xau → hf */
/**
 * 从规范化后的代码里取市场。**不要求前缀后是数字**——
 * 港股指数（hkHSI）和美股（usAAPL）都是字母，原来的 `\d` 会让它们返回 null。
 */
function marketOf(code: string): string | null {
  const m = code.match(/^(sh|sz|bj|hk|us)(?=[0-9a-z])/i)
  if (m) return m[1]!.toLowerCase()
  if (code.startsWith('hf_')) return 'hf'
  return null
}

/** 账户归属校验：该账户必须属于当前用户且 active */
function ownsAccount(db: ReturnType<typeof getDb>, userId: number, accountId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND is_active = 1')
    .get(accountId, userId)
}

export async function investmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  /**
   * GET /api/investments — 扁平持仓列表 + 逐条市值
   *
   * 账户级读数（现金/总投入/浮盈）不在这里返回：那是 /api/assets/portfolio 的职责。
   * 投资页同时调这两个接口，保证和资产页显示的是同一份口径。
   */
  /**
   * 新增/改持仓后**立刻取一次价**。
   *
   * 用户预期很合理：加完持仓就该看到价，而不是显示「待取价」、
   * 还得自己去找「刷新行情」按钮。定时抓取的交易时段门禁不该拖累这个动作。
   *
   * 取不到就取不到（返回 null），不为了"看起来有用"编一个数。
   */
  async function autoFetchQuotes(db: any, codes: string[]): Promise<void> {
    const want = [...codes.map(normalizeCode).filter(Boolean), ...fxCodesFor(codes.map(currencyOf))]
    if (want.length === 0) return
    try {
      const quotes = await fetchQuotes(want)
      if (quotes.length > 0) storeQuotes(db, quotes)
    } catch {
      // 网络/接口挂了不阻塞写入：账户和股数已经落库了，
      // 价只是暂时没有，用户可以手动刷新。宁可显示「待取价」也不假算。
    }
  }

  /* ══════════════════════════════════════════════════════════
     手动刷新行情
     ══════════════════════════════════════════════════════════
     为什么需要这个：定时抓取有交易时段门禁（盘中/收盘后），周末和夜间静默跳过。
     于是投资页只显示「未取到价」——用户既不知道为什么，也没法干预。
     手动刷新**绕过门禁**（用户明确要求，就该去取），并且如实回报每个代码的结果：
     - 拿到的给价和**行情自带日期**（不伪造新鲜度）
     - 拿不到的明确说「腾讯不认这个代码」，而不是静默跳过
     */
  app.post('/api/investments/quotes/refresh', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const rows = db.prepare(
      'SELECT DISTINCT code FROM investments WHERE user_id = ? AND is_active = 1 AND code IS NOT NULL',
    ).all(userId) as Array<{ code: string }>

    // 回报调度状态：让用户知道**为什么没有自动更新**（周末休市 / 非交易时段），
    // 而不是只看到「未取到价」——反馈差的根子就在这里
    const schedule = shouldFetchQuotes()
    const now = (db.prepare(`SELECT datetime('now') t`).get() as { t: string }).t
    const base = { total: rows.length, schedule, at: now }

    if (rows.length === 0) {
      return {
        code: 0,
        data: { ...base, fetched: 0, results: [], missing: [], network: true },
        message: '没有活跃持仓，无需刷新行情',
      }
    }

    const codes = rows.map((r) => r.code)

    // 顺带取汇率：外币持仓要折人民币。
    // 股价和汇率分开取——汇率有自己的兜底源（lib/fx.ts），不该被股价的失败带崩。
    const currencies = [...new Set(codes.map(currencyOf))]
    const fxPromise = fetchFxRates(currencies).catch(() => ({ rates: new Map<string, number>(), source: 'none' as const }))
    let quotes: Quote[]
    try {
      quotes = await fetchQuotes(codes)
    } catch (err) {
      // 网络/接口挂了要单独报：这跟「代码不对」是两回事，用户该做什么完全不同
      return {
        code: 0,
        data: {
          ...base,
          fetched: 0,
          network: false,
          results: [],
          fx: {},
          fxSource: 'none',
          missing: codes.map((c) => ({ code: c, reason: '行情接口连不上，稍后再试' })),
        },
        message: '行情接口连不上，稍后再试',
      }
    }

    // 落库走同一份实现（storeQuotes），三处共用口径
    storeQuotes(db, quotes)

    const got = new Map(quotes.map((q) => [q.code, q]))
    const results: Array<{ code: string; ok: boolean; price?: number; quoteDate?: string; changeRate?: number | null; reason?: string }> = []
    const missing: Array<{ code: string; reason: string }> = []
    // 汇率（腾讯或 ECB 兜底）单独落库
    const fxRes = await fxPromise
    const fx: Record<string, number> = {}
    const today = new Date().toISOString().slice(0, 10)
    for (const [ccy, rate] of fxRes.rates) fx[ccy] = rate
    if (fxRes.rates.size > 0) {
      storeQuotes(db, [...fxRes.rates].map(([ccy, rate]) => ({
        code: `wh${ccy}CNY`, name: `${ccy}人民币`, price: rate,
        prevClose: null, changeRate: null, quoteDate: today, quoteAt: today,
      })))
    }

    for (const code of codes) {
      const norm = normalizeCode(code)
      const q = got.get(norm) ?? got.get(code)
      if (q) {
        results.push({
          code,
          ok: true,
          price: q.price,
          quoteDate: q.quoteDate,
          changeRate: q.changeRate,
        })
      } else {
        const reason = `腾讯不认这个代码（${norm}），检查是不是多/少了字符`
        results.push({ code, ok: false, reason })
        missing.push({ code, reason })
      }
    }

    return {
      code: 0,
      data: { ...base, fetched: results.filter((r) => r.ok).length, network: true, results, missing, fx, fxSource: fxRes.source },
      message: results.every((r) => r.ok)
        ? `已更新 ${results.length} 个标的`
        : `${results.filter((r) => r.ok).length} 个已更新，${missing.length} 个取不到价`,
    }
  })

  app.get('/api/investments', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    // 只返回「活跃持仓 + 活跃账户」的
    const activeAccountIds = new Set(
      (db.prepare('SELECT id FROM accounts WHERE user_id = ? AND is_active = 1')
        .all(userId) as Array<{ id: number }>).map((r) => r.id),
    )
    const market = new Map(
      (db.prepare('SELECT id, market FROM investments WHERE user_id = ?')
        .all(userId) as Array<{ id: number; market: string | null }>).map((r) => [r.id, r.market]),
    )

    const items = loadValuedHoldings(db, userId)
      .filter((h) => activeAccountIds.has(h.accountId))
      .map((h) => ({
        id: h.id,
        accountId: h.accountId,
        code: h.code,
        // 没填名字时用行情返回的名称兜底（用户只填了代码和股数）
        name: h.name || h.quote?.name || null,
        market: market.get(h.id) ?? null,
        kind: h.kind,
        quantity: h.quantity,
        note: h.note,
        updatedAt: h.updatedAt,
        // 市值：行情缺失时为 null，**不编 0** —— UI 显示「—」而不是「归零了」
        marketValue: h.marketValue,
        // 币种相关：外币要折人民币，UI 要标出原币和用了哪个汇率。
        // 漏传会让界面显示成「待补汇率 → CNY」——币种那一格是空的。
        marketValueNative: h.marketValueNative,
        currency: h.currency,
        fxRate: h.fxRate,
        valued: h.valued,
        quote: h.quote
          ? { name: h.quote.name, price: h.quote.price, quoteDate: h.quote.quoteDate, changeRate: h.quote.changeRate }
          : null,
      }))

    /* 自愈：缺哪个币种的汇率就在后台补一次。
       之前「待补汇率」要等用户点刷新，而汇率本来就不该要用户管。
       fire-and-forget，不拖慢本次响应；下次进来就有值了。 */
    try {
      const haveFx = loadLatestFxRates(db)
      const missing = [...new Set(items.map((h) => h.currency))]
        .filter((c) => c !== 'CNY' && !haveFx.has(c))
      if (missing.length > 0) {
        // 主源腾讯 + 兜底 ECB（见 lib/fx.ts），拿不到就保持「待补汇率」
        void fetchFxRates(missing).then(({ rates }) => {
          const today = new Date().toISOString().slice(0, 10)
          const qs = [...rates].map(([ccy, rate]) => ({
            code: `wh${ccy}CNY`, name: `${ccy}人民币`, price: rate,
            prevClose: null, changeRate: null, quoteDate: today, quoteAt: today,
          }))
          if (qs.length > 0) storeQuotes(getDb(), qs)
        }).catch(() => {/* 后台补失败不影响本次响应 */})
      }
    } catch { /* 自愈是尽力而为 */ }

    return { code: 0, data: { items }, message: '' }
  })

  /**
   * POST /api/investments — 新增持仓
   * code 自动 normalize；账户归属校验；同账户同 code 唯一。
   */
  app.post('/api/investments', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createSchema.safeParse(request.body)
    if (!body.success) {
      reply.code(400)
      return { code: 2000, data: null, message: body.error.errors[0]!.message }
    }
    const db = getDb()
    const userId = request.user!.userId
    const { account_id } = body.data

    if (!ownsAccount(db, userId, account_id)) {
      reply.code(400)
      return { code: 2001, data: null, message: `账户 ${account_id} 不存在或不属于当前用户` }
    }

    const code = normalizeInput(body.data.code)
    if (!code) {
      reply.code(400)
      return { code: 2000, data: null, message: '代码无法识别' }
    }

    /**
     * 唯一约束是 `UNIQUE(user_id, account_id, code)`，**不看 is_active**；
     * 而删除是软删（is_active=0 保留历史）。所以「删掉再加回来」如果直接
     * INSERT 会被唯一约束挡下，报「已有此标的」——用户永远加不回来。
     * 正确做法是**复活**那一行，而不是插新的。
     */
    const existing = db.prepare(
      'SELECT id, is_active FROM investments WHERE user_id = ? AND account_id = ? AND code = ?',
    ).get(userId, account_id, code) as { id: number; is_active: number } | undefined

    if (existing && existing.is_active === 1) {
      reply.code(400)
      return { code: 3001, data: null, message: '该账户下已有此标的（可直接编辑份额）' }
    }

    if (existing) {
      db.prepare(
        `UPDATE investments
            SET is_active = 1, name = ?, market = ?, kind = ?, quantity = ?, note = ?,
                updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`,
      ).run(
        body.data.name ?? null, marketOf(code), body.data.kind,
        body.data.quantity, body.data.note ?? null, existing.id, userId,
      )
      // 加完立刻取价：用户不该看到「待取价」还要手动刷新
      await autoFetchQuotes(db, [code])
      const row = db.prepare('SELECT * FROM investments WHERE id = ?').get(existing.id)
      return { code: 0, data: row, message: '已添加持仓' }
    }

    const result = db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId, account_id, code,
      body.data.name ?? null, marketOf(code), body.data.kind,
      body.data.quantity, body.data.note ?? null,
    )
    // 加完立刻取价：用户不该看到「待取价」还要手动刷新
    await autoFetchQuotes(db, [code])
    const row = db.prepare('SELECT * FROM investments WHERE id = ?').get(result.lastInsertRowid)
    return { code: 0, data: row, message: '已添加持仓' }
  })

  /**
   * PATCH /api/investments/:id — 改股数 / 名称 / 备注
   * 只能改自己账户下的持仓。
   * 加减仓只改 quantity，**不改总投入**（买卖不改变"一共投进去多少"）——
   * 总投入是账户级的，在投资页顶部单独维护。
   */
  app.patch('/api/investments/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = updateSchema.safeParse(request.body)
    if (!body.success) {
      reply.code(400)
      return { code: 2000, data: null, message: body.error.errors[0]!.message }
    }
    const db = getDb()
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    // 归属校验：持仓必须属于当前用户（investments.user_id）
    const existing = db
      .prepare('SELECT id FROM investments WHERE id = ? AND user_id = ? AND is_active = 1')
      .get(Number(id), userId)
    if (!existing) {
      reply.code(404)
      return { code: 3002, data: null, message: '持仓不存在' }
    }

    const updates: string[] = []
    const params: unknown[] = []
    if (body.data.name !== undefined) { updates.push('name = ?'); params.push(body.data.name) }
    if (body.data.quantity !== undefined) { updates.push('quantity = ?'); params.push(body.data.quantity) }
    if (body.data.note !== undefined) { updates.push('note = ?'); params.push(body.data.note) }

    if (updates.length === 0) {
      reply.code(400)
      return { code: 2000, data: null, message: '没有需要更新的字段' }
    }
    updates.push("updated_at = datetime('now')")

    params.push(Number(id), userId)
    db.prepare(`UPDATE investments SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params)

    const row = db.prepare('SELECT * FROM investments WHERE id = ?').get(Number(id))
    return { code: 0, data: row, message: '已更新' }
  })

  /**
   * DELETE /api/investments/:id — 软删（is_active=0，保留历史，不物理删）
   */
  app.delete('/api/investments/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb()
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const result = db
      .prepare("UPDATE investments SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND is_active = 1")
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '持仓不存在' }
    }
    return { code: 0, data: null, message: '已删除' }
  })
}
