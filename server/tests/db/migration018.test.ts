/**
 * migration 018 的分支判据回归。
 *
 * `app_updates` 从 011 起就没有 UNIQUE(version_code)，生产库历史上可能有重复行
 * （日志里 26 次上传）。直接建唯一索引会让**启动失败**，所以 018 先安全去重再建索引。
 * 这里锁住：去重保留哪一条（优先 is_active=1，其次最大 id），以及索引确实是唯一的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration018 } from '../../src/db/schema.js'

let db: Database.Database

/** 011 之后的 app_updates schema（含非唯一索引，模拟生产现状） */
function fresh() {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE app_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_name TEXT NOT NULL,
      version_code INTEGER NOT NULL,
      changelog TEXT,
      force_update INTEGER DEFAULT 0,
      apk_url TEXT NOT NULL,
      apk_size INTEGER NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_app_updates_active ON app_updates(is_active);
    CREATE INDEX idx_app_updates_version_code ON app_updates(version_code);
  `)
  return d
}

const rowsFor = (code: number) =>
  db.prepare('SELECT id, is_active FROM app_updates WHERE version_code = ? ORDER BY id').all(code) as
    Array<{ id: number; is_active: number }>

beforeEach(() => { db = fresh() })
afterEach(() => { db.close() })

describe('migration 018 · 去重 + 唯一索引', () => {
  it('同 version_code 优先保留 is_active=1，其次保留最大 id', () => {
    db.exec(`
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('a', 100, '/x/a.apk', 1, 1);   -- id 1 激活
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('a2', 100, '/x/a2.apk', 1, 0); -- id 2 非激活 → 删
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('b', 200, '/x/b.apk', 1, 0);   -- id 3 非激活 → 删（id 4 激活）
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('b2', 200, '/x/b2.apk', 1, 1); -- id 4 激活 → 留
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('c', 300, '/x/c.apk', 1, 0);   -- id 5 非激活 → 删（id 6 更大）
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('c2', 300, '/x/c2.apk', 1, 0); -- id 6 → 留
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('d', 400, '/x/d.apk', 1, 0);   -- 唯一 → 留
    `)

    db.exec(migration018)

    expect(rowsFor(100)).toEqual([{ id: 1, is_active: 1 }])
    expect(rowsFor(200)).toEqual([{ id: 4, is_active: 1 }])
    expect(rowsFor(300)).toEqual([{ id: 6, is_active: 0 }])
    expect(rowsFor(400)).toEqual([{ id: 7, is_active: 0 }])
    expect((db.prepare('SELECT COUNT(*) c FROM app_updates').get() as { c: number }).c).toBe(4)
  })

  it('去重后 version_code 唯一：再插重复会被 SQLite 拒绝', () => {
    db.exec(`
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('a', 100, '/x/a.apk', 1, 1);
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('a2', 100, '/x/a2.apk', 1, 0);
    `)
    db.exec(migration018)

    expect(() =>
      db
        .prepare(
          `INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
           VALUES ('dup', 100, '/x/dup.apk', 1, 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE/i)
  })

  it('无重复行时原样保留（幂等）', () => {
    db.exec(`
      INSERT INTO app_updates (version_name, version_code, apk_url, apk_size, is_active)
        VALUES ('a', 100, '/x/a.apk', 1, 1);
    `)
    db.exec(migration018)
    expect(rowsFor(100)).toEqual([{ id: 1, is_active: 1 }])
  })
})
