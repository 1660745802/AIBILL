/**
 * `lib/admin-purge.ts` —— 删除用户时的数据清除（C1 从 `routes/admin.ts` 深化出的 module）
 *
 * 直接测 module 本身（不走 HTTP），锁三件事，都是「不写在一处就会悄悄错」的：
 *   ① 17 张 user 维度表的行全清（漏一张就是**永久孤儿行**：`ai_parse_filters` 无外键，
 *      删完用户后没人再读它）；
 *   ② **删除顺序是 module 自己的性质**：`PRAGMA foreign_keys = ON` 下先删父表
 *      （`categories`/`accounts`）会抛 `SQLITE_CONSTRAINT_FOREIGNKEY` —— 所以本用例
 *      造满 17 张表的数据后直接调 `purgeUserData`，顺序错就会红；
 *   ③ 只置空不删：`invite_codes` / `notification_rules` 是全局资源，`created_by`
 *      置 NULL；**他人的行一根不动**。
 *
 * 另断言清单的形状（顺序/末位/`admin_unparsed_triage` 不在清单内），让「新增带外键的表」
 * 必须显式插进正确位置这件事有护栏。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDb, closeDb, getDb } from '../../src/db/index.js'
import { ensureAdminUser } from '../../src/services/auth.service.js'
import { purgeUserData, USER_SCOPED_TABLES } from '../../src/lib/admin-purge.js'

type Db = ReturnType<typeof getDb>

let db: Db
let target: number
let other: number

const mkUser = (name: string): number =>
  Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(name).lastInsertRowid)
const count = (sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { c: number }).c

beforeAll(() => {
  process.env.DB_PATH = ':memory:'
  try { closeDb() } catch { /* 首次 */ }
  db = initDb()
  ensureAdminUser()

  target = mkUser('purge_target')
  other = mkUser('purge_other')
  // 另一个用户也留一行交易：删 target 时它必须完好无损
  db.prepare(
    "INSERT INTO transactions (user_id, type, amount, date, description) VALUES (?, 'expense', 1000, '2026-07-02', '别人的')",
  ).run(other)

  // ── 把 17 张表都填上（顺序错 → 外键会当场抛）──
  const acct = Number(
    db.prepare("INSERT INTO accounts (user_id, name) VALUES (?, '微信')").run(target).lastInsertRowid,
  )
  db.prepare("INSERT INTO categories (user_id, name, type) VALUES (?, '餐饮', 'expense')").run(target)
  db.prepare(
    "INSERT INTO transactions (user_id, type, amount, date, description) VALUES (?, 'expense', 3200, '2026-07-02', '午饭')",
  ).run(target)
  db.prepare(
    'INSERT INTO budgets (user_id, amount, year, month, category_id) VALUES (?, 10000, 2026, 7, (SELECT id FROM categories WHERE user_id = ? LIMIT 1))',
  ).run(target, target)
  db.prepare(
    "INSERT INTO subscriptions (user_id, name, amount, cycle, start_date) VALUES (?, '视频会员', 2500, 'monthly', '2026-01-01')",
  ).run(target)
  db.prepare(
    "INSERT INTO financial_goals (user_id, name, type, target_amount) VALUES (?, '旅行', 'saving', 100000)",
  ).run(target)
  db.prepare(
    "INSERT INTO recurring_patterns (user_id, name, type, amount, frequency) VALUES (?, '房租', 'expense', 300000, 'monthly')",
  ).run(target)
  db.prepare(
    'INSERT INTO asset_snapshots (user_id, account_id, balance, snapshot_date) VALUES (?, ?, 1000, \'2026-07-02\')',
  ).run(target, acct)
  db.prepare(
    "INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity) VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 100)",
  ).run(target, acct)
  db.prepare(
    "INSERT INTO ai_conversations (user_id, session_id, role, content) VALUES (?, 's1', 'user', '你好')",
  ).run(target)
  db.prepare("INSERT INTO ai_parse_logs (user_id, raw_input, status) VALUES (?, '午饭32', 'success')").run(target)
  db.prepare(
    'INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms) VALUES (?, \'双11\', \'inbound\', 0, \'["marketing"]\', 0)',
  ).run(target)
  db.prepare("INSERT INTO ai_memories (user_id, content) VALUES (?, '默认用微信支付')").run(target)
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'theme', 'dark')").run(target)
  db.prepare(
    "INSERT INTO client_capture_samples (user_id, channel, package, kind, stage, blocked_by, content_hash) VALUES (?, 'nls', 'com.x', 'notification', 'capture', 'b', 'h')",
  ).run(target)
  for (const userId of [target, other]) {
    db.prepare(
      `INSERT INTO client_filter_stats (user_id, client_version, channel, window_start, window_end, rule_id, hits)
       VALUES (?, '1.4.0', 'nls', '2026-10-12 00:00:00', '2026-10-12 23:59:59', 'precheck.no_signal', 3)`,
    ).run(userId)
    db.prepare(
      `INSERT INTO client_filter_totals (user_id, client_version, channel, window_start, window_end, notifications, blocked)
       VALUES (?, '1.4.0', 'nls', '2026-10-12 00:00:00', '2026-10-12 23:59:59', 100, 3)`,
    ).run(userId)
  }

  // ── 人工裁决：一条挂在 target 的解析行上、一条是 target 作为 admin 写的（都必须清）──
  const logId = (db.prepare('SELECT id FROM ai_parse_logs WHERE user_id = ?').get(target) as { id: number }).id
  db.prepare(
    "INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id) VALUES (?, 'mark_not_bill', '广告', ?)",
  ).run(logId, target)
  const otherLog = Number(
    db.prepare("INSERT INTO ai_parse_logs (user_id, raw_input, status) VALUES (?, '别人的', 'success')").run(other).lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id) VALUES (?, 'mark_rule_missing', '补规则', ?)",
  ).run(otherLog, target)
  db.prepare(
    "INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id) VALUES (?, 'mark_bill', '真账', ?)",
  ).run(otherLog, other)

  // ── 全局资源：target 与 other 各建一条，只有 target 的 created_by 该被置空 ──
  const code = db.prepare('INSERT INTO invite_codes (code, created_by) VALUES (?, ?)')
  code.run('TGT', target)
  code.run('OTH', other)
  const rule = db.prepare('INSERT INTO notification_rules (version, rules, created_by) VALUES (?, ?, ?)')
  rule.run(1001, '{"nls":{}}', target)
  rule.run(1002, '{"nls":{}}', other)
})

afterAll(() => closeDb())

describe('lib/admin-purge · purgeUserData', () => {
  it('清单形状：17 张表、父表最后、裁决表不在清单内（它有自己的前置清法）', () => {
    expect(USER_SCOPED_TABLES.length).toBe(17)
    expect(USER_SCOPED_TABLES.slice(-2)).toEqual(['categories', 'accounts'])
    expect(USER_SCOPED_TABLES).toContain('client_capture_samples')
    expect(USER_SCOPED_TABLES).toContain('client_filter_stats')
    expect(USER_SCOPED_TABLES).toContain('client_filter_totals')
    expect(USER_SCOPED_TABLES).not.toContain('admin_unparsed_triage')
  })

  it('17 张表的行全清；users 行本身保留；不因外键抛错（顺序即约束）', () => {
    expect(() => purgeUserData(db, target)).not.toThrow()

    const TABLES = [
      'asset_snapshots', 'recurring_patterns', 'subscriptions', 'financial_goals', 'investments',
      'transactions', 'client_capture_samples', 'client_filter_stats', 'client_filter_totals',
      'ai_conversations', 'ai_parse_logs', 'ai_parse_filters',
      'ai_memories', 'budgets', 'user_settings', 'categories', 'accounts',
    ]
    for (const t of TABLES) {
      expect(count(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`, target), `${t} 应被清空`).toBe(0)
    }
    // purgeUserData 只清业务数据，users 行由调用方（DELETE /users/:id）删
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', target)).toBe(1)
  })

  it('admin_unparsed_triage：挂在目标解析行上 + 目标作为 admin 写的都清；他人写的保留', () => {
    const rows = db
      .prepare('SELECT reason, admin_id FROM admin_unparsed_triage ORDER BY id')
      .all() as Array<{ reason: string; admin_id: number }>
    // 造了 3 条：（目标的 log，目标 admin）→ 清；（他人的 log，目标 admin）→ 清；（他人的 log，他人 admin）→ 留
    expect(rows).toEqual([{ reason: '真账', admin_id: other }])
  })

  it('全局资源只置空 target 的 created_by，他人的行不动', () => {
    const inv = db.prepare('SELECT code, created_by FROM invite_codes ORDER BY code').all() as Array<{
      code: string
      created_by: number | null
    }>
    expect(inv).toEqual([
      { code: 'OTH', created_by: other },
      { code: 'TGT', created_by: null },
    ])

    const rules = db.prepare('SELECT version, created_by FROM notification_rules ORDER BY version').all() as Array<{
      version: number
      created_by: number | null
    }>
    expect(rules).toEqual([
      { version: 1001, created_by: null },
      { version: 1002, created_by: other },
    ])
  })

  it('他人数据未被误删（同库另一用户完整保留）', () => {
    expect(count('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?', other)).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM ai_parse_logs WHERE user_id = ?', other)).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM ai_parse_filters WHERE user_id = ?', other)).toBe(0)
    expect(db.prepare('SELECT hits FROM client_filter_stats WHERE user_id = ?').all(other)).toEqual([{ hits: 3 }])
    expect(db.prepare('SELECT notifications, blocked FROM client_filter_totals WHERE user_id = ?').all(other))
      .toEqual([{ notifications: 100, blocked: 3 }])
  })

  it('幂等：对同一用户再跑一次不抛错、不改变结果', () => {
    expect(() => purgeUserData(db, target)).not.toThrow()
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', target)).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM invite_codes WHERE code = ?', 'TGT')).toBe(1)
  })
})
