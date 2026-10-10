/**
 * 定时任务模块
 * - 订阅自动记账：到期的 auto_record 订阅自动生成交易
 * - 回收站自动清理：软删除超过 30 天的记录永久删除
 * - 行情抓取：盘中每小时 + 收盘后，写入 investment_quotes
 *
 * 在 app 启动时注册，每小时执行一次检查
 */
import { getDb } from '../db/index.js'
import { appLog as log } from './logger.js'
import crypto from 'node:crypto'
import { fetchQuotes, currencyOf, fxCodesFor } from '../lib/quotes.js'
import { storeQuotes } from '../lib/investments-repo.js'
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

  const gate = shouldFetchQuotes()
  if (gate.fetch) {
    // 行情抓取是 async 且会失败（非官方接口），必须自己吞错，
    // 不能让它把上面几个同步任务的结果带崩
    await processQuoteFetch().catch((err) => {
      log('warn', 'scheduler', `行情抓取异常: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  log('info', 'scheduler', '定时任务执行完毕')
}


/* ══════════════════════════════════════════════════════════
   行情抓取：盘中每小时 + 收盘后
   ══════════════════════════════════════════════════════════ */

/**
 * 什么时候该抓。三个时段，理由不同：
 *
 *  - 盘中（9:30-11:30 / 13:00-15:00）：每小时一次。盘中价格对净资产这个量级
 *    影响很小，分钟级是浪费；小时级足够看出当天浮盈的变化。
 *  - 收盘后（15:00-15:40）：**这次最重要**。收盘价是净资产的锚，
 *    净值曲线和「今天值多少」都应该以它为准。
 *  - 其它时段：不抓。夜间跑同一个价，写进去只是伪造新鲜度。
 *
 * 用**服务器本地时间**判断即可：A 股是单一时区，自部署没有跨时区部署的动机。
 */
export function shouldFetchQuotes(now = new Date()): { fetch: boolean; reason: string } {
  const day = now.getDay()
  if (day === 0 || day === 6) return { fetch: false, reason: '周末休市' }

  const mins = now.getHours() * 60 + now.getMinutes()
  const inSession = (mins >= 9 * 60 + 25 && mins <= 11 * 60 + 35)
    || (mins >= 12 * 60 + 55 && mins <= 15 * 60 + 5)
  if (inSession) return { fetch: true, reason: '盘中' }

  if (mins > 15 * 60 + 5 && mins <= 15 * 60 + 40) return { fetch: true, reason: '收盘后' }

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

  const needFx = fxCodesFor(rows.map((r) => currencyOf(r.code)))
  if (needFx.length === 0) return

  try {
    const quotes = await fetchQuotes(needFx)
    if (quotes.length > 0) storeQuotes(db, quotes)
    log('info', 'fx', `汇率已更新 ${quotes.length}/${needFx.length}`)
  } catch (err) {
    // 汇率失败不影响股价抓取，只记一笔
    log('warn', 'fx', `汇率抓取失败（维持旧汇率）: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function processQuoteFetch(): Promise<void> {
  const db = getDb()
  const rows = db.prepare(
    `SELECT DISTINCT code FROM investments WHERE is_active = 1 AND code IS NOT NULL`,
  ).all() as Array<{ code: string }>

  if (rows.length === 0) return

  const codes = rows.map((r) => r.code)
  try {
    // 汇率由 processFxRateFetch 单独抓（不走门禁），这里只管股价
    const quotes = await fetchQuotes(codes)
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO investment_quotes
         (code, name, price, prev_close, change_rate, quote_date, quoted_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'tencent')`,
    )
    const write = db.transaction(() => {
      for (const q of quotes) {
        stmt.run(q.code, q.name, q.price, q.prevClose, q.changeRate, q.quoteDate, q.quoteAt)
      }
    })
    write()
    log('info', 'quotes', `已更新 ${quotes.length}/${codes.length} 个标的行情`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 这条要留痕：接口改格式/被限流时，这是唯一能查到的线索
    log('warn', 'quotes', `行情抓取失败（保持旧数据，不写快照）: ${msg}`)
  }
}

let intervalId: NodeJS.Timeout | null = null

/**
 * 启动定时任务（app 启动时调用）
 * 每小时执行一次，启动时也立即执行一次
 */
export function startScheduler(): void {
  // 启动后延迟 5 秒执行第一次（等 DB 初始化完毕）
  setTimeout(() => {
    void runScheduledTasks()
  }, 5000)

  // 每小时执行
  intervalId = setInterval(() => {
    void runScheduledTasks()
  }, 60 * 60 * 1000)

  log('info', 'scheduler', '定时任务调度器已启动（每小时执行）')
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
