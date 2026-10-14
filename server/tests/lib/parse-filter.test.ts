import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDb, getDb } from '../../src/db/index.js'
import { recordFiltered, filterStats, reasonsByCount } from '../../src/lib/parse-filter.js'

describe('ai_parse_filters 降本统计', () => {
  beforeAll(() => {
    const db = initDb()
    db.exec('DELETE FROM ai_parse_filters')
  })

  it('记录并统计被挡下的请求', () => {
    const db = getDb()
    recordFiltered(db, { userId: 1, rawInput: '双11', stage: 'inbound', tier: 0, reasons: ['marketing'], durationMs: 0 })
    recordFiltered(db, { userId: 1, rawInput: '芭芭农场', stage: 'inbound', tier: 0, reasons: ['marketing'], durationMs: 1 })
    recordFiltered(db, { userId: 1, rawInput: '记账日报', stage: 'outbound', tier: 0, reasons: ['self_report'], durationMs: 3 })
    recordFiltered(db, { userId: 2, rawInput: '别人的', stage: 'inbound', tier: 0, reasons: ['marketing'], durationMs: 0 })

    const all = filterStats(db, null, 30)
    expect(all.total).toBe(4)
    expect(all.inbound).toBe(3)
    expect(all.outbound).toBe(1)
    expect(all.byReason[0]).toEqual({ reason: 'marketing', count: 3 })

    // 用户隔离
    const u1 = filterStats(db, 1, 30)
    expect(u1.total).toBe(3)
    expect(u1.medianMs).toBe(1)
  })

  it('reasonsByCount：逐条理由计数、stage 过滤、坏 JSON 不炸', () => {
    const db = getDb()
    db.exec('DELETE FROM ai_parse_filters')
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')

    // 一条带两个理由（两条都算 1）
    recordFiltered(db, { userId: 1, rawInput: 'a', stage: 'inbound', tier: 2, reasons: ['money_only', 'bare_amount'], durationMs: 0 })
    recordFiltered(db, { userId: 1, rawInput: 'b', stage: 'outbound', tier: 0, reasons: ['self_report'], durationMs: 0 })
    recordFiltered(db, { userId: 2, rawInput: 'c', stage: 'inbound', tier: 0, reasons: ['money_only'], durationMs: 0 })
    // 坏 JSON 行：不得抛错，也不贡献任何 reason
    db.prepare(
      'INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms) VALUES (?,?,?,?,?,?)',
    ).run(1, 'bad', 'inbound', 0, '{not json', 0)

    // 跨用户 + 只入站：money_only 出现 2 次（a 与 c），bare_amount 1 次，self_report 被 stage 滤掉
    const inbound = reasonsByCount(db, { since, stage: 'inbound' })
    expect(inbound).toEqual([
      { reason: 'money_only', count: 2 },
      { reason: 'bare_amount', count: 1 },
    ])
    // 不带 stage：self_report 也在
    expect(reasonsByCount(db, { since }).find((r) => r.reason === 'self_report')?.count).toBe(1)
    // 单用户隔离
    expect(reasonsByCount(db, { since, userId: 2 })).toEqual([{ reason: 'money_only', count: 1 }])
  })
})
