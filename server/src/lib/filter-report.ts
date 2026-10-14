/**
 * 客户端拦截计数上报（契约 docs/API.md 附录 C §4）
 *
 * 客户端在**发请求前**用自己的判据链拦掉通知，并把它拦了什么按窗口聚合上报。
 * 服务端只做三件事：**收下、按命名空间分类、把它与服务端那套口径并排展示**。
 *
 * 关键设计（都是为了避免「第三种口径」）：
 *
 * 1. **命名空间只有两个**：
 *    - `precheck.*` —— 命中服务端下发的 precheck 判据，`rule_id` 与服务端 reason
 *      逐字对应（前缀剥离即可对账），**可比**；
 *    - `client_only.*` —— 客户端独有判据（自身通知/系统摘要/日报/去重/熔断），
 *      服务端**没有对应物**，**不参与误杀率比较**（不要假装能比）。
 *    其他前缀一律 400：否则第三方命名空间会让「可比/不可比」这条线立刻腐掉。
 *
 * 2. **同一窗口重复上报是覆盖，不是累加**：客户端把某个窗口的聚合结果重试上报
 *    应该得到同一结果（幂等），否则网络重试会把计数翻倍。
 *
 * 3. **不比服务端拿不到的东西**：本模块只搬运计数与聚合，**不计算「误杀率」**——
 *    误杀要靠语料（`expect_txn`）判定，用计数相减算出来的比率是编的。
 */

import type { getDb } from '../db/index.js'
import { derivePrecheck } from './precheck.js'
import { reasonsByCount } from './parse-filter.js'

type Db = ReturnType<typeof getDb>

export const CHANNELS = ['nls', 'sms', 'a11y', 'manual'] as const
export type Channel = (typeof CHANNELS)[number]

/**
 * `precheck.<reason>` / `client_only.<name>`；其余前缀不接受。
 *
 * 导出是为了让 `prefilter_policy` 的键校验与这里**同源**：云控下发的键必须与 ⑤ 上报
 * 用的是同一套 rule_id 命名，否则 `forward/sample` 永远对不上客户端实际拦截用的 id。
 */
export const RULE_ID_RE = /^(precheck|client_only)\.([A-Za-z0-9_.+:-]{1,100})$/

export type RuleNamespace = 'precheck' | 'client_only'

/** 该 rule_id 属于哪个命名空间；不合法 → null（路由层转 400） */
export function ruleNamespace(ruleId: string): RuleNamespace | null {
  const m = RULE_ID_RE.exec(ruleId)
  if (!m) return null
  return m[1] as RuleNamespace
}

/** 窗口跨度上限（天）：再长就不是「窗口聚合」而是「搬总量」了 */
export const MAX_WINDOW_DAYS = 31

/** 带显式时区（`Z` 或 `±HH:MM`/`±HHMM`） */
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i
/** 「北京墙钟」写法 `YYYY-MM-DD HH:MM[:SS]`（无时区） */
const BJ_WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * 把窗口时间归一成 **UTC** 的 `YYYY-MM-DD HH:MM:SS`（存库/去重都用这个形状）。
 *
 * ⚠️ 两个坑都踩过：
 *
 * 1. **不能直接 `Date.parse(value)` 了事**：对无时区的串（`2026-10-12 00:00:00`），
 *    JS 按**本机时区**解释 → 同一份数据在 UTC 容器与本地开发机上归一出两个结果
 *    （容器差 8 小时），幂等键跟服务器时区跑。所以显式分两条路：
 *    - 带 `Z`/`±HH:MM`：按该偏移解析；
 *    - 不带时区：按**北京时间**解释（项目口径，DATA §1.2），再减 8h 转 UTC。
 * 2. **为什么存 UTC**：其余时间戳（`created_at` 等）都是 SQLite `datetime('now')` = UTC，
 *    存北京墙钟会让「最近 N 天」的过滤与它们差 8 小时。
 *
 * 返回 null = 不可解析/日期不存在（路由层转 400）。
 */
export function normalizeWindow(value: string): string | null {
  const v = value.trim()
  const toUtc = (ts: number): string =>
    new Date(ts).toISOString().slice(0, 19).replace('T', ' ')

  if (HAS_TZ.test(v)) {
    const ts = Date.parse(v)
    return Number.isNaN(ts) ? null : toUtc(ts)
  }

  const m = BJ_WALL.exec(v)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  // 把「北京墙钟」当 UTC 解析后再减 8h（中国不实行夏令时，固定 UTC+8）
  const asIfUtc = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}Z`)
  if (Number.isNaN(asIfUtc)) return null
  return toUtc(asIfUtc - 8 * 3_600_000)
}

/** 当前 precheck 清单里的 rule_id（用于判断「可比」；客户端版本旧时会有差集） */
export function currentPrecheckIds(): Set<string> {
  return new Set(derivePrecheck().rules.map((r) => r.id))
}

export interface FilterReportInput {
  userId: number
  clientVersion: string
  channel: Channel
  windowStart: string
  windowEnd: string
  counts: Array<{ rule_id: string; count: number }>
  totals: { notifications: number; blocked: number }
}

export interface SaveFilterReportResult {
  /** 落库的 rule 行数 */
  accepted: number
  /** 属于 `precheck.*` 但**不在当前清单**里的 id（契约漂移信号，回给客户端便于双方发现） */
  unknownPrecheckIds: string[]
}

/**
 * 幂等写入（同窗口覆盖）：两张表都在同一事务里 upsert。
 */
export function saveFilterReport(db: Db, input: FilterReportInput): SaveFilterReportResult {
  const known = currentPrecheckIds()
  const unknownPrecheckIds: string[] = []

  const upsertCount = db.prepare(`
    INSERT INTO client_filter_stats
      (user_id, client_version, channel, window_start, window_end, rule_id, hits, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, client_version, channel, window_start, window_end, rule_id)
    DO UPDATE SET hits = excluded.hits, updated_at = datetime('now')
  `)
  const upsertTotals = db.prepare(`
    INSERT INTO client_filter_totals
      (user_id, client_version, channel, window_start, window_end, notifications, blocked, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, client_version, channel, window_start, window_end)
    DO UPDATE SET notifications = excluded.notifications, blocked = excluded.blocked,
                  updated_at = datetime('now')
  `)

  db.transaction(() => {
    for (const c of input.counts) {
      if (c.rule_id.startsWith('precheck.') && !known.has(c.rule_id)) unknownPrecheckIds.push(c.rule_id)
      upsertCount.run(
        input.userId,
        input.clientVersion,
        input.channel,
        input.windowStart,
        input.windowEnd,
        c.rule_id,
        c.count,
      )
    }
    upsertTotals.run(
      input.userId,
      input.clientVersion,
      input.channel,
      input.windowStart,
      input.windowEnd,
      input.totals.notifications,
      input.totals.blocked,
    )
  })()

  return { accepted: input.counts.length, unknownPrecheckIds }
}

export interface ClientRuleStat {
  rule_id: string
  namespace: RuleNamespace
  /** 是否与当前 precheck 清单对得上（`client_only.*` 恒为 false：服务端无对应判据） */
  comparable: boolean
  hits: number
}

/**
 * 客户端捕获层漏斗（从 `client_filter_stats` 机械归类，**不新增接口**）。
 *
 * 归类只按**前缀/固定 id**，**不维护 id→语义映射**（映射会腐；语义真源在客户端）：
 * - `client_only.capture_received_*` → received（入口）
 * - `client_only.capture_dropped_*`  → dropped（捕获层早退）
 * - `client_only.unparsed_ai_failed` → AI 失败丢弃（AI 已应答之后；服务端无对应判据）
 *
 * ⚠️ `received - dropped` 只是「**通过捕获层**」的数，**不等于**真正入账数（后面还有预筛/解析）。
 */
export interface ClientFunnel {
  received: number
  dropped: number
  unparsed_ai_failed: number
  by_channel: Array<{ channel: string; received: number; dropped: number; unparsed_ai_failed: number }>
  /** 捕获层早退按原因（`capture_dropped_*`，降序）—— 定位「在哪一层丢的」 */
  dropped_reasons: Array<{ rule_id: string; hits: number }>
}

export interface FilterStatsReport {
  window: { days: number }
  client: {
    by_rule: ClientRuleStat[]
    by_channel: Array<{ channel: string; notifications: number; blocked: number; block_rate: number | null }>
    totals: { notifications: number; blocked: number; block_rate: number | null }
    /** 捕获层漏斗（只含 `capture_*` / `unparsed_ai_failed` 这几个前缀） */
    funnel: ClientFunnel
  }
  /** 服务端侧对照：`ai_parse_filters` 的**入站** reason 计数（出站不在 precheck 范围，故剔除） */
  server: { by_reason: Array<{ reason: string; hits: number }> }
  /** 明说：误杀率不能从计数相减得出，要看语料 `expect_txn` */
  note: string
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 汇总客户端上报 + 服务端入站拦截原因，供 admin 视图并排展示。
 * `userId` 为 null 时跨用户聚合（只含计数，不含任何用户内容）。
 */
export function loadFilterStats(db: Db, userId: number | null, days: number): FilterStatsReport {
  const since = sinceIso(days)
  const userCond = userId == null ? '' : ' AND user_id = ?'
  const userArg = userId == null ? [] : [userId]

  const rows = db
    .prepare(
      `SELECT rule_id, SUM(hits) AS hits FROM client_filter_stats
        WHERE window_end >= ?${userCond}
        GROUP BY rule_id ORDER BY hits DESC`,
    )
    .all(since, ...userArg) as Array<{ rule_id: string; hits: number }>

  const known = currentPrecheckIds()
  const by_rule: ClientRuleStat[] = rows.map((r) => {
    const ns = ruleNamespace(r.rule_id) ?? 'client_only'
    return {
      rule_id: r.rule_id,
      namespace: ns,
      comparable: ns === 'precheck' && known.has(r.rule_id),
      hits: r.hits,
    }
  })

  /* 捕获层漏斗：按 (渠道 × rule_id) 再聚合一次。客户端上报是**按渠道**的（每条报告带
     `channel`），所以 channel 列就是权威维度；`unparsed_ai_failed` 是单键但同行带渠道。 */
  const ruleChannelRows = db
    .prepare(
      `SELECT channel, rule_id, SUM(hits) AS hits FROM client_filter_stats
        WHERE window_end >= ?${userCond}
        GROUP BY channel, rule_id`,
    )
    .all(since, ...userArg) as Array<{ channel: string; rule_id: string; hits: number }>

  const RECEIVED_PREFIX = 'client_only.capture_received_'
  const DROPPED_PREFIX = 'client_only.capture_dropped_'
  const UNPARSED_AI_FAILED_ID = 'client_only.unparsed_ai_failed'
  const funnelByChannel = new Map<string, { received: number; dropped: number; unparsed_ai_failed: number }>()
  const droppedReasons = new Map<string, number>()
  let fReceived = 0
  let fDropped = 0
  let fUnparsed = 0
  for (const r of ruleChannelRows) {
    const bucket = r.rule_id.startsWith(RECEIVED_PREFIX)
      ? 'received'
      : r.rule_id.startsWith(DROPPED_PREFIX)
        ? 'dropped'
        : r.rule_id === UNPARSED_AI_FAILED_ID
          ? 'unparsed'
          : null
    if (bucket === null) continue
    const cell = funnelByChannel.get(r.channel) ?? { received: 0, dropped: 0, unparsed_ai_failed: 0 }
    if (bucket === 'received') {
      fReceived += r.hits
      cell.received += r.hits
    } else if (bucket === 'dropped') {
      fDropped += r.hits
      cell.dropped += r.hits
      droppedReasons.set(r.rule_id, (droppedReasons.get(r.rule_id) ?? 0) + r.hits)
    } else {
      fUnparsed += r.hits
      cell.unparsed_ai_failed += r.hits
    }
    funnelByChannel.set(r.channel, cell)
  }
  const funnel: ClientFunnel = {
    received: fReceived,
    dropped: fDropped,
    unparsed_ai_failed: fUnparsed,
    by_channel: [...funnelByChannel.entries()]
      .map(([channel, v]) => ({ channel, ...v }))
      .sort((a, b) => a.channel.localeCompare(b.channel)),
    dropped_reasons: [...droppedReasons.entries()]
      .map(([rule_id, hits]) => ({ rule_id, hits }))
      .sort((a, b) => b.hits - a.hits),
  }

  const channelRows = db
    .prepare(
      `SELECT channel, SUM(notifications) AS notifications, SUM(blocked) AS blocked
         FROM client_filter_totals
        WHERE window_end >= ?${userCond}
        GROUP BY channel ORDER BY channel`,
    )
    .all(since, ...userArg) as Array<{ channel: string; notifications: number; blocked: number }>

  const by_channel = channelRows.map((c) => ({
    channel: c.channel,
    notifications: c.notifications,
    blocked: c.blocked,
    block_rate: c.notifications > 0 ? Number((c.blocked / c.notifications).toFixed(4)) : null,
  }))
  const totalNotifications = by_channel.reduce((s, c) => s + c.notifications, 0)
  const totalBlocked = by_channel.reduce((s, c) => s + c.blocked, 0)

  // 服务端对照：只取入站（出站是模型调用之后的事，precheck 覆盖不到）
  // by-reason 读模型的唯一实现在 parse-filter.ts（同一张表不再有第二份 JSON.parse）
  const serverByReason = reasonsByCount(db, { since, stage: 'inbound' })

  return {
    window: { days },
    client: {
      by_rule,
      by_channel,
      totals: {
        notifications: totalNotifications,
        blocked: totalBlocked,
        block_rate: totalNotifications > 0 ? Number((totalBlocked / totalNotifications).toFixed(4)) : null,
      },
      funnel,
    },
    server: {
      by_reason: serverByReason.map((r) => ({ reason: r.reason, hits: r.count })),
    },
    note:
      '误杀率不能由计数相减得出（要看语料 expect_txn 的 P0 断言）；client_only.* 服务端无对应判据，' +
      '不参与比较——它含「客户端独有判据 + 诊断计数」，id 语义由客户端维护（名单见 docs/API.md 附录 C §4）；' +
      '其中 client_only.precheck_unknown_expr 是**契约漂移告警**（说明客户端的 precheck 形态与当前清单对不上），不是拦截计数。',
  }
}
