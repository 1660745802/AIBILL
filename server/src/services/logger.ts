/**
 * 统一应用日志服务
 * 同时输出到 console + 持久化到 app_logs 表
 */
import { getDb } from '../db/index.js'

export function appLog(level: 'info' | 'warn' | 'error', module: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`
  const extra = data ? JSON.stringify(data) : null
  if (level === 'error') {
    console.error(`${prefix} ${message}`, extra || '')
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`, extra || '')
  } else {
    console.log(`${prefix} ${message}`, extra || '')
  }

  // 持久化到 app_logs 表
  try {
    const db = getDb()
    db.prepare(
      `INSERT INTO app_logs (level, module, message, data, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(level, module, message, extra, timestamp)
  } catch {
    // 日志写入失败不阻塞业务
  }
}
