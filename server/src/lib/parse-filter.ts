/**
 * 预筛记录
 *
 * 「这次没有调用模型」不是一个解析结果，是一个独立事件，所以单独记一张表
 * （`ai_parse_filters`），不去污染 `ai_parse_logs`：
 *
 *   线上 1419 条日志里 759 条（53%）是被规则挡下的纯噪声。它们如果混进
 *   `ai_parse_logs.status`，「空结果率」这个指标就废了——分不清「模型不行」
 *   和「这是条广告」。上一版统计出的 34.6% 空结果率大部分就是后者。
 *
 * 不重建 `ai_parse_logs` 来加 `filtered` 状态：为了一个枚举值去
 * DROP+RENAME 一张 1419 行的表，收益不抵风险。
 */

type Db = ReturnType<typeof import('../db/index.js').getDb>

export interface FilterRecord {
  userId: number
  rawInput: string
  cleanedInput?: string | null
  /** inbound = 调模型前挡下；outbound = 模型给了结果后判定为噪声 */
  stage: 'inbound' | 'outbound'
  /** classifyNotification 的档位：0 = 命中噪声，4 = 无任何信号 */
  tier: number
  reasons: string[]
  /** 判定本身花掉的毫秒数。分流是纯字符串匹配，应当远小于 1ms */
  durationMs: number
  /**
   * 入口归因（契约 §0）：`nls`｜`sms`｜`a11y`｜`manual`，客户端可送、可缺省。
   *
   * ⚠️ 2026-10-16 起**有一个例外**：`bare_amount` 信号带入口约束
   * （`BARE_AMOUNT_CHANNELS = ['manual']`，见 `ai/verify.ts` 的事故说明）。
   * 「预筛行为不因入口而异」这条老原则仍然成立——变的是**某条信号在哪些入口成立**，
   * 而不是同一段文本在不同入口得到不同判据。除此之外 channel 仍只是统计维度。
   */
  channel?: string | null
  /** 来源应用包名（契约 §0 的 `source.package_name`），同样只留档 */
  sourcePackage?: string | null
}

export function recordFiltered(db: Db, rec: FilterRecord): number {
  const res = db
    .prepare(
      `INSERT INTO ai_parse_filters
         (user_id, raw_input, cleaned_input, stage, tier, reasons, duration_ms, channel, source_package)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.userId,
      rec.rawInput,
      rec.cleanedInput ?? null,
      rec.stage,
      rec.tier,
      JSON.stringify(rec.reasons),
      rec.durationMs,
      rec.channel ?? null,
      rec.sourcePackage ?? null,
    )
  return Number(res.lastInsertRowid)
}

export interface ReasonCount {
  reason: string
  count: number
}

/**
 * `ai_parse_filters.reasons` 是 JSON 数组列（一次拦截可有多条理由）。
 * 展开成「每个 reason 被多少行提到」——**这是这张表 by-reason 读模型的唯一实现**。
 *
 * 此前 `filterStats`（本文件）与 `filter-report.loadFilterStats` 各写一份
 * SQL + `JSON.parse`，同一张表的读模型两个版本（仓库反复踩的「同一个数字两套算法」）。
 * 两者现在都调它：服务端对照用 `stage:'inbound'`，降本统计用不带 stage（全部）。
 *
 * @param since 只统计 `created_at >= since` 的行（与调用方同一时间口径，UTC `YYYY-MM-DD HH:MM:SS`）
 * @param userId `null`/缺省 = 跨用户聚合（只含计数，不含任何用户内容）
 * @param stage 可选，只统计入站/出站之一
 */
export function reasonsByCount(
  db: Db,
  opts: { since: string; userId?: number | null; stage?: 'inbound' | 'outbound' },
): ReasonCount[] {
  const conds = ['created_at >= ?']
  const args: unknown[] = [opts.since]
  if (opts.userId != null) {
    conds.unshift('user_id = ?')
    args.unshift(opts.userId)
  }
  if (opts.stage) {
    conds.push('stage = ?')
    args.push(opts.stage)
  }
  const rows = db
    .prepare(
      `SELECT reasons, COUNT(*) AS hits FROM ai_parse_filters
        WHERE ${conds.join(' AND ')} GROUP BY reasons`,
    )
    .all(...args) as Array<{ reasons: string | null; hits: number }>

  const map = new Map<string, number>()
  for (const r of rows) {
    let list: string[] = []
    try { list = JSON.parse(r.reasons || '[]') } catch { list = [] }
    for (const reason of list) map.set(reason, (map.get(reason) ?? 0) + r.hits)
  }
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

export interface FilterStats {
  /** 被挡下的总次数 */
  total: number
  inbound: number
  outbound: number
  /** 判定自身耗时的中位数与最大值（ms）——预筛必须比模型快两个数量级 */
  medianMs: number
  maxMs: number
  /** 按 reason 分组，用来判断哪条规则在干活、哪条规则在误伤 */
  byReason: Array<{ reason: string; count: number }>
  days: number
  perDay: number
}

/**
 * 降本统计：这些被挡下的请求，本来每一次都要花一次模型调用
 * （线上 P50 约 4 秒）。
 */
export function filterStats(db: Db, userId: number | null, sinceDays = 30): FilterStats {
  // 注意：userId 为 null 时不能拼出空 WHERE 再接 AND——那会产生 `FROM t  AND ...` 语法错误
  const conds = ['created_at >= ?']
  const args: unknown[] = []
  const since = new Date(Date.now() - sinceDays * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  args.push(since)
  if (userId != null) {
    conds.unshift('user_id = ?')
    args.unshift(userId)
  }
  const where = `WHERE ${conds.join(' AND ')}`

  const total = db
    .prepare(`SELECT count(*) c FROM ai_parse_filters ${where}`)
    .get(...args) as { c: number }
  const inbound = db
    .prepare(`SELECT count(*) c FROM ai_parse_filters ${where} AND stage='inbound'`)
    .get(...args) as { c: number }
  const outbound = total.c - inbound.c

  const durations = (
    db
      .prepare(`SELECT duration_ms FROM ai_parse_filters ${where} ORDER BY duration_ms`)
      .all(...args) as Array<{ duration_ms: number }>
  ).map((r) => r.duration_ms)

  const dayRows = db
    .prepare(
      `SELECT DISTINCT substr(created_at,1,10) d FROM ai_parse_filters ${where}`,
    )
    .all(...args) as Array<{ d: string }>
  const dayCount = dayRows.length

  const byReason = reasonsByCount(db, { since, userId })

  return {
    total: total.c,
    inbound: inbound.c,
    outbound,
    medianMs: durations.length ? durations[Math.floor(durations.length / 2)]! : 0,
    maxMs: durations.length ? durations[durations.length - 1]! : 0,
    byReason,
    days: dayCount,
    perDay: dayCount ? Math.round(total.c / dayCount) : 0,
  }
}
