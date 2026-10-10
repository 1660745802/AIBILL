import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDb, getDb } from '../../src/db/index.js'
import { recordFiltered, filterStats } from '../../src/lib/parse-filter.js'

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
})
