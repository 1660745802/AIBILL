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
}

export function recordFiltered(db: Db, rec: FilterRecord): number {
  const res = db
    .prepare(
      `INSERT INTO ai_parse_filters
         (user_id, raw_input, cleaned_input, stage, tier, reasons, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.userId,
      rec.rawInput,
      rec.cleanedInput ?? null,
      rec.stage,
      rec.tier,
      JSON.stringify(rec.reasons),
      rec.durationMs,
    )
  return Number(res.lastInsertRowid)
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

  const rows = db
    .prepare(`SELECT reasons FROM ai_parse_filters ${where}`)
    .all(...args) as Array<{ reasons: string | null }>

  const byReason = new Map<string, number>()
  for (const r of rows) {
    let list: string[] = []
    try { list = JSON.parse(r.reasons || '[]') } catch { list = [] }
    for (const reason of list) byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }

  return {
    total: total.c,
    inbound: inbound.c,
    outbound,
    medianMs: durations.length ? durations[Math.floor(durations.length / 2)]! : 0,
    maxMs: durations.length ? durations[durations.length - 1]! : 0,
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    days: dayCount,
    perDay: dayCount ? Math.round(total.c / dayCount) : 0,
  }
}
