/**
 * 定时任务模块
 * - 订阅自动记账：到期的 auto_record 订阅自动生成交易
 * - 回收站自动清理：软删除超过 30 天的记录永久删除
 * - 行情抓取：盘中每 15 分钟 + 收盘后，写入 investment_quotes
 *
 * 在 app 启动时注册，每 15 分钟执行一次检查（URL 门禁决定是否真抓）
 */
import { getDb } from '../db/index.js'
import { appLog as log } from './logger.js'
import crypto from 'node:crypto'
import { currencyOf, marketOfCode, type Market } from '../lib/quotes.js'
import { acquireAndStorePrices, acquireAndStoreFxRates } from '../lib/quote-acquisition.js'

import { applyTxn } from '../lib/account-balance.js'

/**
 * 订阅自动记账
 * 检查所有 auto_record=1 且 next_payment_date <= today 的 active 订阅
 * 为每个到期订阅生成一笔交易，并推进 next_payment_date
 */
function processSubscriptionAutoRecord(): void {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)

  const dueSubscriptions = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE status = 'active' AND auto_record = 1
         AND next_payment_date IS NOT NULL
         AND next_payment_date <= ?`,
    )
    .all(today) as Array<{
    id: number
    user_id: number
    name: string
    amount: number
    cycle: string
    category_id: number | null
    account_id: number | null
    next_payment_date: string
  }>

  if (dueSubscriptions.length === 0) return

  log('info', 'scheduler', `发现 ${dueSubscriptions.length} 个到期订阅需要自动记账`)

  const insertTx = db.prepare(
    `INSERT INTO transactions
      (user_id, client_id, client_type, source, source_detail, type, amount,
       category_id, account_id, target_account_id, description, date, time,
       tags, ai_raw_input, client_created_at, status)
     VALUES (?, ?, 'web', 'subscription', ?, 'expense', ?, ?, ?, NULL, ?, ?, NULL, '[]', NULL, NULL, 'confirmed')`,
  )

  const updateNextDate = db.prepare(
    `UPDATE subscriptions SET next_payment_date = ?, updated_at = datetime('now') WHERE id = ?`,
  )

  const processAll = db.transaction(() => {
    for (const sub of dueSubscriptions) {
      const clientId = crypto.randomUUID()

      // 幂等检查：避免重复记账（同一订阅同一天）
      const existing = db
        .prepare(
          `SELECT id FROM transactions
           WHERE user_id = ? AND source = 'subscription' AND source_detail = ?
             AND date = ? AND deleted_at IS NULL`,
        )
        .get(sub.user_id, `subscription:${sub.id}`, sub.next_payment_date)

      if (existing) {
        log('warn', 'scheduler', `订阅 #${sub.id}(${sub.name}) 已有 ${sub.next_payment_date} 记录，跳过`)
        continue
      }

      // 创建交易
      const insRes = insertTx.run(
        sub.user_id,
        clientId,
        `subscription:${sub.id}`,
        sub.amount,
        sub.category_id,
        sub.account_id,
        `${sub.name}（自动记账）`,
        sub.next_payment_date,
      )

      /* 订阅自动记账同样是有归属的支出，要从账户余额里扣。
         漏了这条 = 每月自动扣款的账户余额只涨不跌。 */
      // ⚠️ 必须传真实 lastInsertRowid：applyTxn 用它和基准线比较，
      // 缺了会退化成 NaN 而**整段跳过基准线保护**（静默出错）。
      applyTxn(db, {
        id: insRes.lastInsertRowid,
        type: 'expense',
        amount: sub.amount,
        account_id: sub.account_id,
        target_account_id: null,
        status: 'confirmed',
      }, 1, sub.user_id)

      // 计算下一个付款日
      const months = sub.cycle === 'monthly' ? 1 : sub.cycle === 'quarterly' ? 3 : 12
      const nextDate = new Date(sub.next_payment_date)
      nextDate.setMonth(nextDate.getMonth() + months)
      const nextPaymentStr = nextDate.toISOString().slice(0, 10)

      updateNextDate.run(nextPaymentStr, sub.id)

      log('info', 'scheduler', `订阅自动记账: ${sub.name} ¥${(sub.amount / 100).toFixed(2)}`, {
        subscription_id: sub.id,
        user_id: sub.user_id,
        date: sub.next_payment_date,
        next: nextPaymentStr,
      })
    }
  })

  try {
    processAll()
  } catch (err) {
    log('error', 'scheduler', `订阅自动记账失败: ${(err as Error).message}`)
  }
}

/**
 * 回收站自动清理
 * 永久删除 deleted_at 超过 30 天的记录
 */
function processTrashCleanup(): void {
  const db = getDb()
  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ')

  const result = db
    .prepare('DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .run(cutoffDate)

  if (result.changes > 0) {
    log('info', 'scheduler', `回收站清理: 永久删除 ${result.changes} 条过期记录`, { cutoff: cutoffDate })
  }
}

/**
 * 应用日志清理
 * - app_logs: 保留 30 天
 * - ai_parse_logs: 保留 90 天
 * - ai_conversations: 保留 90 天
 */
function processLogCleanup(): void {
  const db = getDb()

  // app_logs 保留 30 天
  const appLogCutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ')
  const appLogResult = db
    .prepare('DELETE FROM app_logs WHERE created_at < ?')
    .run(appLogCutoff)
  if (appLogResult.changes > 0) {
    log('info', 'scheduler', `应用日志清理: 删除 ${appLogResult.changes} 条（>30天）`)
  }

  // ai_parse_logs 保留 90 天
  const parseCutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ')
  const parseResult = db
    .prepare('DELETE FROM ai_parse_logs WHERE created_at < ?')
    .run(parseCutoff)
  if (parseResult.changes > 0) {
    log('info', 'scheduler', `AI解析日志清理: 删除 ${parseResult.changes} 条（>90天）`)
  }

  // ai_conversations 保留 90 天
  const convResult = db
    .prepare('DELETE FROM ai_conversations WHERE created_at < ?')
    .run(parseCutoff)
  if (convResult.changes > 0) {
    log('info', 'scheduler', `AI对话记录清理: 删除 ${convResult.changes} 条（>90天）`)
  }
}

/**
 * 执行所有定时任务。
 *
 * ⚠️ 行情抓取必须在这里调用。曾经 processQuoteFetch / shouldFetchQuotes 写好了
 * 但**没有任何调用者** —— 结果是 investment_quotes 永远是 0 行、持仓永远
 * 「未取到价」、账户总价值永远算不出（持仓的市值部分缺失）。
 * 单测抓不到，因为测试夹具手工往表里插价，绕开了调度器。
 * 以后加任务同理：**函数定义在下面不等于它会跑**。
 */
export async function runScheduledTasks(): Promise<void> {
  log('info', 'scheduler', '定时任务开始执行')
  processSubscriptionAutoRecord()
  processTrashCleanup()
  processLogCleanup()

  // 汇率无条件抓（不认交易时段）；股价才受门禁
  await processFxRateFetch().catch((err) => {
    log('warn', 'scheduler', `汇率任务异常: ${err instanceof Error ? err.message : String(err)}`)
  })

  // 门禁在 processQuoteFetch 内部按**市场**判断（A股/港股/美股时段不同），
  // 这里不预先拦——否则美股（北京夜里）永远进不来。
  await processQuoteFetch().catch((err) => {
    log('warn', 'scheduler', `行情抓取异常: ${err instanceof Error ? err.message : String(err)}`)
  })

  log('info', 'scheduler', '定时任务执行完毕')
}


/* ══════════════════════════════════════════════════════════
   行情抓取：盘中每 15 分钟 + 收盘后
   ══════════════════════════════════════════════════════════ */

/**
 * 取**北京时间的**星期与「当天已过分钟数」。
 *
 * ⚠️ 不能用 `now.getHours()` / `now.getDay()`——那是**服务器本地时间**，
 * 而容器通常跑在 UTC。这个坑真踩过：容器 `date` 是 `Sat Oct 10 12:45 UTC`，
 * 北京时间已经是 20:45，门禁于是按 UTC 小时判断：
 *   北京 10:00（盘中）= UTC 02:00 → `getHours()=2` → 判成「非交易时段」，不抓
 *   北京 18:00（收盘）= UTC 10:00 → 判成「盘中」，抓
 * 结果是**盘中一次都不抓、收盘后反而在抓**，而且完全静默。
 *
 * A 股只有北京时间一个时区，所以写死 UTC+8 是正确的（中国不实行夏令时）。
 */
function beijingNow(now: Date): { day: number; mins: number } {
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const mins = (utcMins + 8 * 60) % 1440
  // 加 8 小时若跨过 UTC 午夜，北京日期要 +1 天
  const day = mins < utcMins ? (now.getUTCDay() + 1) % 7 : now.getUTCDay()
  return { day, mins }
}

/** 北京日期 YYYY-MM-DD（用于和行情自带日期比对，判断今天是不是交易日） */
export function beijingDate(now = new Date()): string {
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000
  const bj = new Date(utc + 8 * 60 * 60_000)
  return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`
}

const MARKET_LABEL: Record<Market, string> = { cn: 'A股', hk: '港股', us: '美股' }

/**
 * 各市场交易时段（**北京时间**，当天分钟数）。收盘后各留一小段缓冲，
 * 用来捕获收盘价——收盘价是净资产的锚。
 *
 *  | 市场 | 当地 | 北京时间 |
 *  |---|---|---|
 *  | A股  | 9:30-11:30 / 13:00-15:00 | 同左 |
 *  | 港股 | 9:30-12:00 / 13:00-16:00 | 同左（**比 A 股晚 1 小时收盘**） |
 *  | 美股 | 9:30-16:00 ET | **21:30-04:00**（夏令时）/ 22:30-05:00（冬令时） |
 *
 * 美股跨午夜，所以 window 会绕回 0 点。这里用「21:25 到次日 05:40」的宽窗口
 * 把夏令时/冬令时都覆盖住——多抓的那段拿到的是上一交易日收盘价，
 * 有 `UNIQUE(code, quote_date, quoted_at)` 去重，不会写脏数据。
 */
const SESSIONS: Record<Market, Array<[number, number]>> = {
  // 收盘后各留 ~40 分钟：收盘价要等清算所结算才定下来，
  // 这段里反复抓拿到的是同一个价，有 UNIQUE 去重，不会写脏数据。
  cn: [[9 * 60 + 25, 11 * 60 + 35], [12 * 60 + 55, 15 * 60 + 40]],
  hk: [[9 * 60 + 25, 12 * 60 + 5], [12 * 60 + 55, 16 * 60 + 40]],
  us: [[21 * 60 + 25, 24 * 60 - 1], [0, 5 * 60 + 40]],
}

/**
 * 什么时候该抓。
 *
 * **必须传市场**：只判断「现在是不是 A 股的盘中」会让港股收盘价（16:00）
 * 和美股（北京夜里）永远抓不到——港股的日 K 会一直停在 15:00 那个价。
 *
 * 这里只管「时间窗口」，不管「今天是不是交易日」——节假日靠
 * `processQuoteFetch` 里的数据推断（拿回来的行情日期不是今天 ⇒ 今天休市），
 * 这样春节/国庆/台风临时休市都不用维护日历。
 */
export function shouldFetchQuotes(
  now = new Date(),
  markets: Market[] = ['cn'],
): { fetch: boolean; reason: string; market?: Market } {
  const { day, mins } = beijingNow(now)
  if (day === 0 || day === 6) return { fetch: false, reason: '周末休市' }

  for (const m of markets) {
    for (const [from, to] of SESSIONS[m]) {
      if (mins >= from && mins <= to) {
        return { fetch: true, reason: `${MARKET_LABEL[m]}盘中`, market: m }
      }
    }
  }
  return { fetch: false, reason: '非交易时段' }
}

/**
 * 抓取所有用户持仓的行情并落库。
 *
 * 失败**不抛到外面**、也**不写任何快照**：腾讯是非官方接口，会改格式也会限流。
 * 写一条错的价格比不写更危险——页面上会显示一个看起来很新的假数字。
 * 这里只记日志，等下次整点重试。
 */
/**
 * 取折人民币需要的汇率。
 *
 * **不走交易时段门禁**：汇率不是股价，它没有"盘中/收盘"的概念，
 * 而缺它会让整个外币持仓算不出人民币市值（宁可显示「待补汇率」也不假算）。
 * 之前汇率是跟着行情抓取走的，于是周末/夜间静默跳过 →
 * 新增持仓后汇率永远拿不到，用户只能自己点刷新。
 */
export async function processFxRateFetch(): Promise<void> {
  const db = getDb()
  const rows = db.prepare(
    `SELECT DISTINCT code FROM investments WHERE is_active = 1 AND code IS NOT NULL`,
  ).all() as Array<{ code: string }>
  if (rows.length === 0) return

  const currencies = [...new Set(rows.map((r) => currencyOf(r.code)))]
  if (currencies.every((c) => c === 'CNY')) return

  // 取（主源 + ECB 兜底）与落库都在 quote-acquisition module 内；
  // 这里只决定**记什么**。汇率失败不抛错也不阻塞股价抓取。
  const acq = await acquireAndStoreFxRates(db, currencies)
  if (acq.stored > 0) {
    log('info', 'fx', `汇率已更新 ${acq.stored} 个（来源 ${acq.source}）`, {
      currencies: [...acq.rates.keys()].join(','),
    })
  }
  if (acq.missing.length > 0) {
    // 失败原因在 errors 里：上游改格式/限流时，这是唯一能查到的线索
    log('warn', 'fx', `汇率未补齐 ${acq.missing.join(',')}（维持旧汇率）`, {
      errors: acq.errors.join(' | '),
    })
  }
}

/**
 * 记住「某个北京日期已确认休市」。
 *
 * 节假日（春节/国庆在周中）和临时休市（台风）没法靠星期判断，而维护一张
 * 交易日历要年年更新、还挡不住临时休市。所以**从数据推断**：
 * 盘中去抓一次，如果拿回来的行情日期**不是今天**，说明今天根本没开市。
 *
 * 只记一天，日期一变自动失效。
 */
/** 每个市场各自的「今天已确认休市」——A股休市不代表美股也休。 */
const marketClosedOn: Record<Market, string | null> = { cn: null, hk: null, us: null }

export function marketClosedDate(market: Market): string | null {
  return marketClosedOn[market]
}

/** 仅供测试：清掉「今日休市」缓存（模块级状态会跨用例残留） */
export function resetMarketClosedCache(): void {
  for (const k of Object.keys(marketClosedOn) as Market[]) marketClosedOn[k] = null
}

/** 判断「休市」要等够久：开盘头几分钟拿到的可能还是上一交易日的日期 */
function deepEnoughBeijng(now: Date, market: Market): boolean {
  const { mins } = beijingNow(now)
  if (market === 'us') return mins >= 22 * 60 || mins <= 5 * 60  // 美股跨夜
  return mins >= 10 * 60
}

export async function processQuoteFetch(now = new Date()): Promise<void> {
  const db = getDb()
  const rows = db.prepare(
    `SELECT DISTINCT code FROM investments WHERE is_active = 1 AND code IS NOT NULL`,
  ).all() as Array<{ code: string }>
  if (rows.length === 0) return

  // 按市场分组：A股 / 港股 / 美股 的交易时段完全不同
  const byMarket = new Map<Market, string[]>()
  for (const r of rows) {
    const m = marketOfCode(r.code)
    byMarket.set(m, [...(byMarket.get(m) ?? []), r.code])
  }

  const today = beijingDate(now)
  // 只抓「此刻在交易时段内」且「今天还没被判定休市」的市场
  const targets = [...byMarket.keys()].filter((m) => {
    if (marketClosedOn[m] === today) return false
    return shouldFetchQuotes(now, [m]).fetch
  })
  if (targets.length === 0) return

  const codes = targets.flatMap((m) => byMarket.get(m) ?? [])
  // 抓取 + 落库 + 降级事实在 module 内；这里的策略只有两个：
  // 「只抓当前在交易时段且未被判定休市的市场」与「节假日从数据推断」。
  const acq = await acquireAndStorePrices(db, codes)
  if (!acq.reachable) {
    // 失败**不写任何快照**：写一条错的价格比不写更危险——
    // 页面上会显示一个看起来很新的假数字。这条要留痕：
    // 接口改格式/被限流时，这是唯一能查到的线索。
    log('warn', 'quotes', `行情抓取失败（保持旧数据，不写快照）: ${acq.degraded[0]?.detail ?? ''}`)
    return
  }
  log('info', 'quotes', `已更新 ${acq.stored}/${codes.length} 个标的（${targets.map((m) => MARKET_LABEL[m]).join('/')}）`)
  if (acq.unknown.length > 0) {
    log('info', 'quotes', `${acq.unknown.length} 个代码上游未返回：${acq.unknown.join(',')}`)
  }

  /* 逐市场识别节假日 / 临时休市：拿回来的行情日期不是今天 ⇒ 该市场今天没开市。
     只在**盘中较深处**才下结论——刚开盘时拿到上一交易日的日期可能只是还没切过来，
     误判会让一整天都不再抓。 */
  for (const m of targets) {
    const mine = acq.quotes.filter((q) => marketOfCode(q.code) === m)
    if (mine.length > 0 && !mine.some((q) => q.quoteDate === today) && deepEnoughBeijng(now, m)) {
      marketClosedOn[m] = today
      log('info', 'quotes', `${MARKET_LABEL[m]} ${today} 非交易日（行情停在 ${mine[0]!.quoteDate}），今日不再抓`)
    }
  }
}

let intervalId: NodeJS.Timeout | null = null

/**
 * 调度间隔（分钟）。
 *
 * 默认 **15 分钟**——因为盘中价格是「净资产」的直接输入，小时级太粗：
 * 早上记的账可能一整天看不到当天的浮盈变化。
 *
 * 重复抓取不会写重复行：`investment_quotes` 有
 * `UNIQUE(code, quote_date, quoted_at)`，而 `quoted_at` 用的是**行情自带的
 * 时间戳**，同一时刻抓多少次都落成一条。所以调密是安全的。
 *
 * 真正决定「要不要抓」的是 `shouldFetchQuotes()` 的门禁（盘中 / 收盘后），
 * 这个间隔只决定「多久检查一次」。休市时段这一跳什么都不做。
 */
export function intervalMinutes(): number {
  const n = Number(process.env.QUOTE_REFRESH_MINUTES)
  return Number.isFinite(n) && n > 0 ? n : 15
}

/**
 * 启动定时任务（app 启动时调用）
 * 每 15 分钟执行一次（`QUOTE_REFRESH_MINUTES` 可调），启动时也立即执行一次
 */
export function startScheduler(): void {
  // 启动后延迟 5 秒执行第一次（等 DB 初始化完毕）
  setTimeout(() => {
    void runScheduledTasks()
  }, 5000)

  const minutes = intervalMinutes()
  intervalId = setInterval(() => {
    void runScheduledTasks()
  }, minutes * 60 * 1000)

  log('info', 'scheduler', `定时任务调度器已启动（每 ${minutes} 分钟检查一次）`)
}

/**
 * 停止定时任务
 */
export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
