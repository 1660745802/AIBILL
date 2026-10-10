/**
 * migration 017 的分区判据回归。
 *
 * 这段 SQL 是「分支条件 + 分区」的组合，最容易被下一次顺手改坏：
 * 曾经用 `WHERE balance_as_of_txn_id = 0` 判断「有没有手填快照」，
 * 会把「有快照但该用户一笔账都没记过」的账户误判为无快照，
 * 用 initial_balance 覆盖掉快照值（实测 88888 → 0）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration017 } from '../../src/db/schema.js'

let db: Database.Database

/** 017 之前那套 schema 的最小子集 */
function fresh() {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
      initial_balance INTEGER DEFAULT 0
    );
    CREATE TABLE asset_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, account_id INTEGER,
      balance INTEGER, snapshot_date TEXT, source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, account_id INTEGER,
      target_account_id INTEGER, type TEXT, amount INTEGER,
      status TEXT DEFAULT 'confirmed', deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return d
}

const balance = (id: number) => (db.prepare('SELECT balance FROM accounts WHERE id = ?').get(id) as any).balance
const baseline = (id: number) =>
  (db.prepare('SELECT balance_as_of_txn_id FROM accounts WHERE id = ?').get(id) as any).balance_as_of_txn_id

beforeEach(() => { db = fresh() })
afterEach(() => { db.close() })

describe('migration 017 · 分支判据', () => {
  it('无手填快照 → 期初 + 重放全部有归属流水，基准线 0', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',1000);
             INSERT INTO transactions (user_id,account_id,type,amount) VALUES (9,1,'expense',300);`)
    db.exec(migration017)
    expect(balance(1)).toBe(700)
    expect(baseline(1)).toBe(0)
  })

  it('有快照 + 该用户零流水 → 保留快照值（曾被 initial_balance 覆盖成 0）', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',5000);
             INSERT INTO asset_snapshots (user_id,account_id,balance,snapshot_date)
               VALUES (9,1,88888,'2026-01-01');`)
    db.exec(migration017)
    expect(balance(1)).toBe(88888)
  })

  it('有快照 + 快照之后新建的流水 → 仍然加减（不能当成已烤进）', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',50000);
             INSERT INTO asset_snapshots (user_id,account_id,balance,snapshot_date,created_at)
               VALUES (9,1,50000,'2026-01-01','2026-01-01 10:00:00');
             INSERT INTO transactions (user_id,account_id,type,amount,created_at)
               VALUES (9,1,'expense',300,'2026-06-01 10:00:00');`)
    db.exec(migration017)
    expect(balance(1)).toBe(49700)
  })

  it('转账双向都算：转出减、转入加', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',1000),(2,9,'B',0);
             INSERT INTO transactions (user_id,account_id,target_account_id,type,amount)
               VALUES (9,1,2,'transfer',400);`)
    db.exec(migration017)
    expect(balance(1)).toBe(600)
    expect(balance(2)).toBe(400)
  })

  it('自转账净影响为 0（转出减与转入加相抵，和运行时 deltasFor 的行为一致）', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',1000);
             INSERT INTO transactions (user_id,account_id,target_account_id,type,amount)
               VALUES (9,1,1,'transfer',400);`)
    db.exec(migration017)
    expect(balance(1)).toBe(1000)
  })

  it('软删的流水不参与重放，pending 不算', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',1000);
             INSERT INTO transactions (user_id,account_id,type,amount,deleted_at)
               VALUES (9,1,'expense',300,'2026-01-01 00:00:00');
             INSERT INTO transactions (user_id,account_id,type,amount,status)
               VALUES (9,1,'expense',200,'pending');`)
    db.exec(migration017)
    expect(balance(1)).toBe(1000)
  })

  it('不同用户的账户互不串味', () => {
    db.exec(`INSERT INTO accounts (id,user_id,name,initial_balance) VALUES (1,9,'A',1000),(2,99,'B',0);
             INSERT INTO asset_snapshots (user_id,account_id,balance,snapshot_date) VALUES (9,1,7000,'2026-01-01');
             INSERT INTO transactions (user_id,account_id,type,amount) VALUES (9,1,'expense',300);`)
    db.exec(migration017)
    expect(balance(1)).toBe(7000)   // 走快照分支
    expect(balance(2)).toBe(0)      // 另一个用户，不能被 user9 的快照命中
  })
})