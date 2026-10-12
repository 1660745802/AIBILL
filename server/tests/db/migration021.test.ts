/**
 * migration 021 结构回归（契约 §4）
 *
 * 锁住三条会「悄悄坏」的性质：
 *   1. 两张表建出来、列齐；
 *   2. `client_filter_stats` 的唯一键**含 channel 且 channel NOT NULL**——
 *      SQLite 唯一索引里 NULL 互不相等，允许 NULL 会让重复上报变成多行（幂等失效）；
 *   3. `client_filter_totals` 同窗口唯一（拦截率的分母不能重复堆）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration021 } from '../../src/db/schema.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    INSERT INTO users (username) VALUES ('u1');
  `)
  db.exec(migration021)
})

afterEach(() => {
  db.close()
})

const cols = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe('migration021 · client_filter_stats / client_filter_totals', () => {
  it('两张表与列齐备', () => {
    expect(cols('client_filter_stats')).toEqual([
      'id',
      'user_id',
      'client_version',
      'channel',
      'window_start',
      'window_end',
      'rule_id',
      'hits',
      'updated_at',
    ])
    expect(cols('client_filter_totals')).toEqual([
      'id',
      'user_id',
      'client_version',
      'channel',
      'window_start',
      'window_end',
      'notifications',
      'blocked',
      'updated_at',
    ])
  })

  it('索引存在（按用户+窗口查）', () => {
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(idx).toContain('idx_client_filter_stats_user_window')
    expect(idx).toContain('idx_client_filter_totals_user_window')
  })

  it('同 (用户/版本/渠道/窗口/rule) 重复插入被唯一键拒绝', () => {
    const ins = db.prepare(
      `INSERT INTO client_filter_stats (user_id, client_version, channel, window_start, window_end, rule_id, hits)
       VALUES (1, '1.4.0', 'nls', '2026-10-01 00:00:00', '2026-10-01 23:59:59', 'precheck.marketing', 1)`,
    )
    ins.run()
    expect(() => ins.run()).toThrow(/UNIQUE/)
    // 换渠道就是另一行（渠道是维度，不是重复）
    db.prepare(
      `INSERT INTO client_filter_stats (user_id, client_version, channel, window_start, window_end, rule_id, hits)
       VALUES (1, '1.4.0', 'sms', '2026-10-01 00:00:00', '2026-10-01 23:59:59', 'precheck.marketing', 1)`,
    ).run()
    expect((db.prepare('SELECT COUNT(*) c FROM client_filter_stats').get() as { c: number }).c).toBe(2)
  })

  it('channel 为 NULL 被拒绝（否则唯一键失效、重复上报变多行）', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO client_filter_stats (user_id, client_version, channel, window_start, window_end, rule_id, hits)
           VALUES (1, '1.4.0', NULL, '2026-10-01 00:00:00', '2026-10-01 23:59:59', 'precheck.marketing', 1)`,
        )
        .run(),
    ).toThrow(/NOT NULL/)
  })

  it('totals 同窗口唯一（分母不重复堆）', () => {
    const ins = db.prepare(
      `INSERT INTO client_filter_totals (user_id, client_version, channel, window_start, window_end, notifications, blocked)
       VALUES (1, '1.4.0', 'nls', '2026-10-01 00:00:00', '2026-10-01 23:59:59', 100, 53)`,
    )
    ins.run()
    expect(() => ins.run()).toThrow(/UNIQUE/)
  })

  it('userId 外键指向 users（预留级联删除能力：PRAGMA foreign_keys=ON 时受约束）', () => {
    db.pragma('foreign_keys = ON')
    expect(() =>
      db
        .prepare(
          `INSERT INTO client_filter_stats (user_id, client_version, channel, window_start, window_end, rule_id, hits)
           VALUES (999, '1.4.0', 'nls', '2026-10-01 00:00:00', '2026-10-01 23:59:59', 'precheck.marketing', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })
})
