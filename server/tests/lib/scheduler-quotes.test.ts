/**
 * 调度器真的会抓行情吗
 *
 * 回归背景：`processQuoteFetch` / `shouldFetchQuotes` 曾经写好了但**没有任何调用者**。
 * 后果是 investment_quotes 永远 0 行 → 持仓永远「未取到价」→ 账户总价值永远算不出。
 * 既有测试抓不到，因为夹具手工插价绕开了调度器。
 *
 * 这个文件专门盯住「定义 ≠ 会跑」这一类。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchQuotes = vi.fn().mockResolvedValue([
  { code: 'sh518880', name: '黄金ETF华安', price: 8.617, prevClose: 8.474, changeRate: 1.69, quoteDate: '2026-10-10', quoteAt: '20261010150000' },
])
vi.mock('../../src/lib/quotes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/quotes.js')>()),
  fetchQuotes,
}))

const { shouldFetchQuotes, runScheduledTasks } = await import('../../src/services/scheduler.js')
const { initDb, getDb } = await import('../../src/db/index.js')

describe('shouldFetchQuotes —— 只在盘中与收盘后抓', () => {
  const at = (s: string) => new Date(s)
  it('盘中抓（上午/下午）', () => {
    expect(shouldFetchQuotes(at('2026-10-09T10:00:00')).fetch).toBe(true)
    expect(shouldFetchQuotes(at('2026-10-09T14:00:00')).fetch).toBe(true)
  })
  it('收盘后抓（这次最重要：收盘价是净资产的锚）', () => {
    expect(shouldFetchQuotes(at('2026-10-09T15:20:00')).fetch).toBe(true)
  })
  it('夜里不抓（跑同一个价只会伪造新鲜度）', () => {
    expect(shouldFetchQuotes(at('2026-10-09T22:00:00')).fetch).toBe(false)
    expect(shouldFetchQuotes(at('2026-10-09T03:00:00')).fetch).toBe(false)
  })
  it('周末不抓', () => {
    expect(shouldFetchQuotes(at('2026-10-10T10:00:00')).fetch).toBe(false)   // 周六
    expect(shouldFetchQuotes(at('2026-10-11T15:20:00')).fetch).toBe(false)  // 周日
  })
})

describe('runScheduledTasks 真的会调用行情抓取', () => {
  beforeEach(() => { fetchQuotes.mockClear() })

  it('有持仓且处于抓取时段 → 调用 fetchQuotes 并落库', async () => {
    const db = initDb()
    db.exec('DELETE FROM investments; DELETE FROM investment_quotes; DELETE FROM accounts; DELETE FROM users;')
    const uid = Number(db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES ('qtest', 'x', 'user')",
    ).run().lastInsertRowid)
    const acc = Number(db.prepare(
      "INSERT INTO accounts (user_id, name, asset_type) VALUES (?, '证券', 'investment')",
    ).run(uid).lastInsertRowid)
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 10000)`,
    ).run(uid, acc)

    // 把时间钉在盘中，否则跑测试的机器可能是夜里/周末，闸门不开就断言不到「会调用」
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
    await runScheduledTasks()

    expect(fetchQuotes).toHaveBeenCalledTimes(1)
    expect(fetchQuotes).toHaveBeenCalledWith(['sh518880'])
    const rows = db.prepare('SELECT code, price FROM investment_quotes').all() as Array<{ code: string; price: number }>
    expect(rows).toEqual([{ code: 'sh518880', price: 8.617 }])
    vi.useRealTimers()
  })
})
