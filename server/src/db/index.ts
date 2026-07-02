/**
 * 数据库连接初始化 + Migration 执行
 * 使用 better-sqlite3 同步 API
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { config } from '../config.js'
import { migration001, seedSettings } from './schema.js'

let db: Database.Database

/**
 * 获取数据库实例（单例）
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('数据库未初始化，请先调用 initDb()')
  }
  return db
}

/**
 * 初始化数据库：创建文件目录 + 建表 + 执行 migration + seed 数据
 */
export function initDb(): Database.Database {
  // 确保数据目录存在
  const dbDir = path.dirname(config.dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // 创建/打开数据库
  db = new Database(config.dbPath)

  // 开启 WAL 模式（提升并发读性能）
  db.pragma('journal_mode = WAL')
  // 开启外键约束
  db.pragma('foreign_keys = ON')

  // 执行 migration
  runMigrations()

  return db
}

/**
 * 关闭数据库连接
 */
export function closeDb(): void {
  if (db) {
    db.close()
  }
}

/**
 * 执行 migration（幂等）
 * 检查 schema_migrations 表中已应用的版本，只执行未应用的
 */
function runMigrations(): void {
  // 先确保 schema_migrations 表存在（鸡生蛋问题）
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const migrations: Array<{ version: number; name: string; sql: string }> = [
    { version: 1, name: 'initial_schema', sql: migration001 },
  ]

  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>
  const appliedVersions = new Set(applied.map((r) => r.version))

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue
    }

    // 在事务内执行 migration
    const runMigration = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      )
    })

    runMigration()
    console.log(`[DB] Migration #${migration.version} (${migration.name}) applied`)
  }

  // Seed 默认数据
  db.exec(seedSettings)
}
