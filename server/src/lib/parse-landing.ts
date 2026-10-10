/**
 * 解析落地关联
 *
 * 线上现状：`/ai/parse` 返回的结果和 `/transactions` 写进去的行之间没有任何关联，
 * 导致 `ai_parse_logs.final_items` 845 条全空、`user_modified` 恒为 0、
 * `ai_memories` 零行——服务端既没法学习，也没有「AI 抽的数到底进没进账本」这个事实。
 *
 * 本模块让服务端**自己**判断落地，不依赖客户端上报：
 *   1. `/ai/parse` 成功返回时，把该次解析的指纹记进短 TTL 缓存
 *   2. `/transactions` 写入时，拿每笔的 (type, amount, date) 去查
 *   3. 查到唯一匹配 → 记下 parse_log_id，并回填 final_items / ai_raw_input
 *
 * 为什么可行（线上实测，不是估的）：
 *   - 解析到落库的时间差  P50 0.2 分钟 / P90 2.8 分钟 / 95% 在 2 小时内
 *   - (user_id, type, amount, date) 指纹能对上 852 个金额里的 600 个（70%），
 *     命中里 92% 是唯一匹配
 * → 30 分钟 TTL 覆盖 94%
 *
 * 查不到就查不到，不猜。宁可少回填，也不能把 A 的解析结果贴到 B 的交易上。
 */

import { getDb } from '../db/index.js'

/** 一笔解析结果的指纹（与 AI 返回的 item 字段一致） */
interface Fingerprint {
  type: string
  amount: number   // 分
  date: string
}

interface Entry {
  logId: number
  rawInput: string
  expiresAt: number
}

/** TTL：覆盖 94% 的解析→落库间隔（P90 是 2.8 分钟，30 分钟留足余量） */
const TTL_MS = 30 * 60 * 1000

/** 同一指纹最多留几条。超过 1 条即视为歧义，查不到就不猜 */
const MAX_PER_KEY = 5

/** userId → 指纹 → 候选解析 */
const index = new Map<number, Map<string, Entry[]>>()

function fpKey(f: Fingerprint): string {
  return `${f.type}|${f.amount}|${f.date}`
}

/**
 * 记一次成功解析。`items` 是即将返回给客户端的那批。
 * 只记带日期和金额的条目——没有它们没法参与指纹匹配。
 */
export function rememberParse(
  userId: number,
  logId: number,
  items: Array<{ type: string; amount: number; date?: string }>,
  rawInput: string,
): void {
  const now = Date.now()
  const byKey = index.get(userId) ?? new Map<string, Entry[]>()

  for (const it of items) {
    if (!it?.date || !Number.isFinite(it.amount)) continue
    const key = fpKey({ type: it.type, amount: it.amount, date: it.date })
    const arr = byKey.get(key) ?? []
    arr.push({ logId, rawInput, expiresAt: now + TTL_MS })
    if (arr.length > MAX_PER_KEY) arr.splice(0, arr.length - MAX_PER_KEY)
    byKey.set(key, arr)
  }

  // 顺带清掉这个用户已过期的条目，防止 Map 无限增长
  for (const [key, arr] of byKey) {
    const alive = arr.filter((e) => e.expiresAt > now)
    if (alive.length === 0) byKey.delete(key)
    else byKey.set(key, alive)
  }
  index.set(userId, byKey)
}

/**
 * 查一笔交易对应的解析日志。
 * 返回 null 表示查不到、或命中多条（歧义）——两种情况都不猜。
 */
export function matchParse(
  userId: number,
  item: { type: string; amount: number; date: string },
): { logId: number; rawInput: string } | null {
  const byKey = index.get(userId)
  if (!byKey) return null
  const arr = byKey.get(fpKey(item))
  if (!arr || arr.length !== 1) return null
  return { logId: arr[0]!.logId, rawInput: arr[0]!.rawInput }
}

/** 测试用：清空缓存 */
export function _resetLandingCache(): void {
  index.clear()
}

/* ══════════════════════════════════════════════════════════
   回填：把关联结果写回数据库
   ══════════════════════════════════════════════════════════ */

/**
 * 回填单条交易的落地信息。幂等：已关联过的直接跳过。
 * 返回是否真的改了库。
 */
export function backfillLanding(
  transactionId: number,
  logId: number,
  rawInput: string,
  items: unknown[],
): boolean {
  const db = getDb()
  const changed = db
    .prepare(
      `UPDATE transactions
          SET parse_log_id = ?, ai_raw_input = COALESCE(ai_raw_input, ?)
        WHERE id = ? AND parse_log_id IS NULL`,
    )
    .run(logId, rawInput, transactionId)
  if (changed.changes === 0) return false

  // final_items 记最终确认的那几笔。
  // 这里先记 AI 原始输出；用户真的改了仍走 /ai/ai/parse-feedback，那条路径会覆盖它。
  db.prepare(
    `UPDATE ai_parse_logs
        SET final_items = COALESCE(final_items, ?)
      WHERE id = ?`,
  ).run(JSON.stringify(items), logId)

  return true
}
