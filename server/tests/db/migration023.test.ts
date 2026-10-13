/**
 * migration 023 结构回归（「不确定」人工裁决记录，docs/ARCHITECTURE.md §3.9）
 *
 * 锁住：
 *   1. 表/列/索引齐；`action` CHECK 只允许三个动作；
 *   2. `UNIQUE(parse_log_id, admin_id, action)`：重复提交被拒（路由层转幂等），不同 action 允许；
 *   3. 外键（`parse_log_id → ai_parse_logs` / `admin_id → users`）——删用户前必须先清，
 *      否则「有裁决记录的用户」删不掉（这是 migration 自带的约束，必须显式测）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration002, migration023 } from '../../src/db/schema.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
    INSERT INTO users (username) VALUES ('admin');
  `)
  db.exec(migration002) // ai_parse_logs
  db.exec(migration023)
  db.prepare(`INSERT INTO ai_parse_logs (user_id, raw_input, status) VALUES (1, 'x', 'error')`).run()
})

afterEach(() => {
  db.close()
})

const cols = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

const ins = (parseLogId: number, action: string, adminId = 1) =>
  db
    .prepare(`INSERT INTO admin_unparsed_triage (parse_log_id, action, reason, admin_id) VALUES (?, ?, ?, ?)`)
    .run(parseLogId, action, 'r', adminId)

describe('migration023 · admin_unparsed_triage', () => {
  it('表/列/索引齐备', () => {
    expect(cols('admin_unparsed_triage')).toEqual([
      'id',
      'parse_log_id',
      'action',
      'reason',
      'admin_id',
      'created_at',
    ])
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(idx).toContain('idx_admin_unparsed_triage_log')
  })

  it('action CHECK：只允许三个动作', () => {
    expect(() => ins(1, 'write_transaction')).toThrow(/CHECK/)
    expect(() => ins(1, 'mark_bill')).not.toThrow()
  })

  it('UNIQUE(parse_log_id, admin_id, action)：重复被拒；不同 action 允许', () => {
    ins(1, 'mark_bill')
    expect(() => ins(1, 'mark_bill')).toThrow(/UNIQUE/)
    expect(() => ins(1, 'mark_not_bill')).not.toThrow()
    // 不同 admin 同一 action 也允许（UNIQUE 含 admin_id）
    db.prepare(`INSERT INTO users (username) VALUES ('admin2')`).run()
    expect(() => ins(1, 'mark_bill', 2)).not.toThrow()
  })

  it('外键：parse_log_id / admin_id 必须存在', () => {
    expect(() => ins(99999, 'mark_bill')).toThrow(/FOREIGN KEY/)
    expect(() => ins(1, 'mark_bill', 99999)).toThrow(/FOREIGN KEY/)
  })

  it('删 ai_parse_logs 前必须先清 triage（否则外键阻止）', () => {
    ins(1, 'mark_bill')
    expect(() => db.prepare('DELETE FROM ai_parse_logs WHERE id = 1').run()).toThrow(/FOREIGN KEY/)
    db.prepare('DELETE FROM admin_unparsed_triage WHERE parse_log_id = 1').run()
    expect(() => db.prepare('DELETE FROM ai_parse_logs WHERE id = 1').run()).not.toThrow()
  })
})
