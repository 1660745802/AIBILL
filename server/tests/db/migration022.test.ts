/**
 * migration 022 结构回归（AI 失败可观测）
 *
 * 锁住两列的存在与可空性：`failure_code`（NULL = 没失败）/ `attempts`（调了几次模型）。
 * 老行天然为 NULL —— 这正是「022 之前的历史数据没有失败归类」这个事实，
 * 不能被 DEFAULT 伪造（否则「AI 挂了」的历史会被算成「没失败」）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migration002, migration019, migration022 } from '../../src/db/schema.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);`)
  db.exec(`INSERT INTO users (username) VALUES ('u1');`)
  db.exec(migration002)
  // 019 同时改 ai_parse_filters；本用例只关心 ai_parse_logs，给它建个最小壳让 ALTER 通过
  db.exec(`CREATE TABLE IF NOT EXISTS ai_parse_filters (id INTEGER PRIMARY KEY AUTOINCREMENT)`)
  db.exec(migration019)
  db.exec(migration022)
})

afterEach(() => {
  db.close()
})

const cols = (table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> =>
  db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>

describe('migration022 · ai_parse_logs.failure_code / attempts', () => {
  it('两列存在、可空、无默认值（老行 NULL = 历史事实，不被伪造）', () => {
    const info = cols('ai_parse_logs')
    for (const name of ['failure_code', 'attempts']) {
      const col = info.find((c) => c.name === name)
      expect(col, `${name} 缺列`).toBeTruthy()
      expect(col!.notnull, `${name} 应可空`).toBe(0)
      expect(col!.dflt_value, `${name} 不应有默认值`).toBeNull()
    }
  })

  it('status 的 CHECK 约束未被改动（不新增枚举值，判非账/失败靠 failure_code 区分）', () => {
    const ins = db.prepare(
      `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, attempts)
       VALUES (1, 'x', ?, NULL, 1)`,
    )
    expect(() => ins.run('filtered')).toThrow(/CHECK/)
  })

  it('新写入可带 failure_code / attempts，且能按它们聚合', () => {
    const ins = db.prepare(
      `INSERT INTO ai_parse_logs (user_id, raw_input, status, failure_code, attempts, channel)
       VALUES (1, 'x', ?, ?, ?, ?)`,
    )
    ins.run('success', null, 2, 'nls')
    ins.run('timeout', 'AI_TIMEOUT', 2, 'a11y')
    ins.run('error', 'parse_format', 1, null)
    ins.run('empty', null, 1, 'sms')

    const rows = db
      .prepare(`SELECT failure_code, COUNT(*) c FROM ai_parse_logs WHERE failure_code IS NOT NULL GROUP BY failure_code ORDER BY failure_code`)
      .all() as Array<{ failure_code: string; c: number }>
    expect(rows).toEqual([
      { failure_code: 'AI_TIMEOUT', c: 1 },
      { failure_code: 'parse_format', c: 1 },
    ])
    const retried = db
      .prepare(`SELECT COUNT(*) c FROM ai_parse_logs WHERE COALESCE(attempts, 1) > 1`)
      .get() as { c: number }
    expect(retried.c).toBe(2)
  })
})
