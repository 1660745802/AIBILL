/**
 * 统一应用日志服务
 * 同时输出到 console + 持久化到 app_logs 表
 */
import { getDb } from '../db/index.js'

export function appLog(level: 'info' | 'warn' | 'error', module: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`
  /* 序列化本身也要包住：`JSON.stringify` 遇到循环引用 / BigInt 会**抛错**，
     而 appLog 的调用点既有路由 handler 也有 onResponse 钩子 ——
     一个打日志的动作不能把主流程（甚至一个已经准备好的 4xx 响应）搞挂。 */
  let extra: string | null = null
  try {
    extra = data ? JSON.stringify(data) : null
  } catch (err) {
    extra = `[unserializable data: ${err instanceof Error ? err.message : String(err)}]`
  }
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
