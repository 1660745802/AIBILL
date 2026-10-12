/**
 * 应用日志服务
 *
 * 两条底线：
 *   1. **打日志不能把主流程搞挂** —— `appLog` 的调用点既有路由 handler
 *      （例如 admin 删除用户失败后的兜底日志）也有 onResponse 钩子。
 *      修复前 `JSON.stringify(data)` 在 try 之外：循环引用/BigInt 会当场抛错，
 *      一个已经准备好的 4xx 响应会变成 500。
 *   2. SQL 全参数化 —— message/module 里的任何字符都按字面落库。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { initDb, getDb } from '../../src/db/index.js'
import { appLog } from '../../src/services/logger.js'

describe('services/logger', () => {
  beforeAll(() => {
    const db = initDb()
    db.exec('DELETE FROM app_logs')
  })

  const lastRow = () =>
    getDb().prepare('SELECT level, module, message, data FROM app_logs ORDER BY id DESC LIMIT 1').get() as {
      level: string; module: string; message: string; data: string | null
    }

  it('不可序列化的 data（循环引用）不许抛错，也要留下线索', () => {
    const circular: Record<string, unknown> = { user_id: 7 }
    circular.self = circular

    expect(() => appLog('error', 'logger_test', '循环引用', circular)).not.toThrow()
    const row = lastRow()
    expect(row.message).toBe('循环引用')
    expect(row.data).toContain('unserializable')
  })

  it('正常 data 照常序列化落库', () => {
    appLog('info', 'logger_test', '普通日志', { user_id: 7, status: 200 })
    expect(JSON.parse(lastRow().data!)).toEqual({ user_id: 7, status: 200 })
  })

  it('message / data 里的 SQL 片段按字面落库（全参数化）', () => {
    appLog('warn', 'logger_test', "'; DROP TABLE app_logs; --", { note: "'; DROP" })
    const row = lastRow()
    expect(row.message).toBe("'; DROP TABLE app_logs; --")
    // 表还在，且这一行确实写进去了
    const count = getDb().prepare('SELECT COUNT(*) c FROM app_logs').get() as { c: number }
    expect(count.c).toBeGreaterThan(0)
  })
})
