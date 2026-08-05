/**
 * 定时任务模块
 * - 订阅自动记账：到期的 auto_record 订阅自动生成交易
 * - 回收站自动清理：软删除超过 30 天的记录永久删除
 *
 * 在 app 启动时注册，每小时执行一次检查
 */
import { getDb } from '../db/index.js'
import { appLog as log } from './logger.js'
import crypto from 'node:crypto'

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
      insertTx.run(
        sub.user_id,
        clientId,
        `subscription:${sub.id}`,
        sub.amount,
        sub.category_id,
        sub.account_id,
        `${sub.name}（自动记账）`,
        sub.next_payment_date,
      )

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
 * 执行所有定时任务
 */
function runScheduledTasks(): void {
  log('info', 'scheduler', '定时任务开始执行')
  processSubscriptionAutoRecord()
  processTrashCleanup()
  log('info', 'scheduler', '定时任务执行完毕')
}

let intervalId: NodeJS.Timeout | null = null

/**
 * 启动定时任务（app 启动时调用）
 * 每小时执行一次，启动时也立即执行一次
 */
export function startScheduler(): void {
  // 启动后延迟 5 秒执行第一次（等 DB 初始化完毕）
  setTimeout(() => {
    runScheduledTasks()
  }, 5000)

  // 每小时执行
  intervalId = setInterval(() => {
    runScheduledTasks()
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
