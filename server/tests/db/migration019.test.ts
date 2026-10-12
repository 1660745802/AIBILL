/**
 * migration 019 的兼容性回归。
 *
 * 019 给两张已有表加可空的入参上下文列（契约 docs/API.md 附录 C §5）。
 * 关键不变量只有两条，正是纯 `ALTER TABLE ADD COLUMN` 想保证的：
 *   1. 新库/已存在的库应用后，新列真的在（PRAGMA table_info 可见）；
 *   2. **老行可读**且新列为 NULL——不加 NOT NULL / DEFAULT，所以旧行不会被
 *      回填成任何「猜出来」的值，旧 INSERT 语句也不会因为缺列而失败。
 * 这里用 019 之前的 schema 子集建库 → 塞老行 → 跑 019 → 断言，模拟生产升级路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration019 } from '../../src/db/schema.js'

let db: Database.Database

/** 019 之前 ai_parse_logs / ai_parse_filters 的最小 schema（列定义与 002/015 一致） */
function fresh() {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE ai_parse_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      raw_input TEXT NOT NULL,
      cleaned_input TEXT,
      ai_response TEXT,
      parsed_items TEXT,
      final_items TEXT,
      status TEXT NOT NULL CHECK(status IN ('success', 'empty', 'error', 'timeout')),
      error_message TEXT,
      duration_ms INTEGER,
      user_modified INTEGER DEFAULT 0,
      modification_detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE ai_parse_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      raw_input TEXT NOT NULL,
      cleaned_input TEXT,
      stage TEXT NOT NULL CHECK(stage IN ('inbound', 'outbound')),
      tier INTEGER NOT NULL,
      reasons TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return d
}

const columns = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)

beforeEach(() => { db = fresh() })
afterEach(() => { db.close() })

describe('migration 019 · 入参上下文列', () => {
  it('应用后两张表都新增了对应列', () => {
    db.exec(migration019)

    expect(columns('ai_parse_logs')).toEqual(
      expect.arrayContaining(['channel', 'source_package', 'received_at', 'hints']),
    )
    expect(columns('ai_parse_filters')).toEqual(
      expect.arrayContaining(['channel', 'source_package']),
    )
  })

  it('老行可读，新列为 NULL（向后兼容，不猜值）', () => {
    db.exec(`
      INSERT INTO ai_parse_logs (user_id, raw_input, status, duration_ms)
        VALUES (7, '午饭32', 'success', 3);
      INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, duration_ms)
        VALUES (7, '双11', 'inbound', 0, 0);
    `)

    db.exec(migration019)

    const log = db.prepare('SELECT * FROM ai_parse_logs WHERE id = 1').get() as Record<string, unknown>
    expect(log.raw_input).toBe('午饭32')
    expect(log.channel).toBeNull()
    expect(log.source_package).toBeNull()
    expect(log.received_at).toBeNull()
    expect(log.hints).toBeNull()

    const filter = db.prepare('SELECT * FROM ai_parse_filters WHERE id = 1').get() as Record<string, unknown>
    expect(filter.raw_input).toBe('双11')
    expect(filter.channel).toBeNull()
    expect(filter.source_package).toBeNull()
  })

  it('新列可写：升级后的 INSERT 能落 channel/source_package/received_at/hints', () => {
    db.exec(migration019)

    db.prepare(
      `INSERT INTO ai_parse_logs
         (user_id, raw_input, status, duration_ms, channel, source_package, received_at, hints)
       VALUES (?, ?, 'success', 1, ?, ?, ?, ?)`,
    ).run(7, '微信支付32.00元', 'nls', 'com.tencent.mm', '2026-10-12T23:40:00+08:00', '{"amount_cents":3200}')

    const log = db.prepare('SELECT * FROM ai_parse_logs WHERE id = 1').get() as Record<string, unknown>
    expect(log.channel).toBe('nls')
    expect(log.source_package).toBe('com.tencent.mm')
    expect(log.received_at).toBe('2026-10-12T23:40:00+08:00')
    expect(log.hints).toBe('{"amount_cents":3200}')

    db.prepare(
      `INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, duration_ms, channel, source_package)
       VALUES (7, '双11', 'inbound', 0, 0, 'sms', 'com.android.mms')`,
    ).run()
    const filter = db.prepare('SELECT * FROM ai_parse_filters WHERE id = 1').get() as Record<string, unknown>
    expect(filter.channel).toBe('sms')
    expect(filter.source_package).toBe('com.android.mms')
  })
})
