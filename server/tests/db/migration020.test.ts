/**
 * migration 020 的分支判据回归。
 *
 * `notification_rules.version` 从 007 起就没有 UNIQUE，生产库历史上可能有重复行
 * （`update_rules.sh` 手推 / 并发写）。直接建唯一索引会让**启动失败**，所以
 * 020 先安全去重（同 version 保留 id 最大）再建索引。这里锁住：
 *   1. 去重保留最大 id；
 *   2. version 唯一索引真的生效；
 *   3. content_hash 列存在、可空、允许多个 NULL（老行）、非 NULL 重复会被拒。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration020 } from '../../src/db/schema.js'

let db: Database.Database

/** 020 之前的 notification_rules schema（含非唯一 version 索引，模拟生产现状） */
function fresh() {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE notification_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      rules TEXT NOT NULL,
      created_by INTEGER,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_notification_rules_active ON notification_rules(is_active);
    CREATE INDEX idx_notification_rules_version ON notification_rules(version);
  `)
  return d
}

const rowsFor = (version: number) =>
  db.prepare('SELECT id FROM notification_rules WHERE version = ? ORDER BY id').all(version) as Array<{ id: number }>

beforeEach(() => { db = fresh() })
afterEach(() => { db.close() })

describe('migration 020 · 去重 + content_hash', () => {
  it('content_hash 列被加上', () => {
    db.exec(migration020)
    const cols = (db.prepare('PRAGMA table_info(notification_rules)').all() as Array<{ name: string }>)
      .map((r) => r.name)
    expect(cols).toContain('content_hash')
  })

  it('同 version 去重保留 id 最大的一条', () => {
    db.exec(`
      INSERT INTO notification_rules (version, rules, is_active) VALUES (1, '{"a":1}', 1);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (1, '{"a":2}', 0);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (2, '{"b":1}', 1);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (2, '{"b":2}', 0);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (3, '{"c":1}', 1);
    `)

    db.exec(migration020)

    expect(rowsFor(1)).toEqual([{ id: 2 }])   // 同 version 保留最大 id
    expect(rowsFor(2)).toEqual([{ id: 4 }])
    expect(rowsFor(3)).toEqual([{ id: 5 }])
    expect((db.prepare('SELECT COUNT(*) c FROM notification_rules').get() as { c: number }).c).toBe(3)
  })

  it('去重后 version 唯一：再插重复会被 SQLite 拒绝', () => {
    db.exec(`
      INSERT INTO notification_rules (version, rules, is_active) VALUES (1, '{}', 1);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (1, '{}', 0);
    `)
    db.exec(migration020)

    expect(() =>
      db.prepare('INSERT INTO notification_rules (version, rules) VALUES (1, ?)').run('{}'),
    ).toThrow(/UNIQUE/i)
  })

  it('content_hash：允许老行多个 NULL，但非 NULL 重复会被拒', () => {
    db.exec(`
      INSERT INTO notification_rules (version, rules, is_active) VALUES (1, '{}', 0);
      INSERT INTO notification_rules (version, rules, is_active) VALUES (2, '{}', 0);
    `)
    db.exec(migration020)

    // 两个 NULL 可以共存（唯一索引在 SQLite 下不约束 NULL）
    expect((db.prepare('SELECT COUNT(*) c FROM notification_rules WHERE content_hash IS NULL').get() as { c: number }).c).toBe(2)

    db.prepare('UPDATE notification_rules SET content_hash = ? WHERE version = 1').run('hash-a')
    db.prepare('UPDATE notification_rules SET content_hash = ? WHERE version = 2').run('hash-b')

    expect(() =>
      db.prepare('INSERT INTO notification_rules (version, rules, content_hash) VALUES (3, ?, ?)').run('{}', 'hash-a'),
    ).toThrow(/UNIQUE/i)
  })
})
