/**
 * 调度器真的会抓行情吗
 *
 * 回归背景：`processQuoteFetch` / `shouldFetchQuotes` 曾经写好了但**没有任何调用者**。
 * 后果是 investment_quotes 永远 0 行 → 持仓永远「未取到价」→ 账户总价值永远算不出。
 * 既有测试抓不到，因为夹具手工插价绕开了调度器。
 *
 * 这个文件专门盯住「定义 ≠ 会跑」这一类。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 上游目录（离线）：按请求的代码过滤，认得的给、不认的给不出——
 * **一条都给不出来就抛**，与真实 `fetchQuotes` 一致。
 * 这个 mock 也同时被 `lib/fx.ts` 的主源用到（它就是问腾讯要 `wh*CNY`）。
 */
const CATALOG = [
  { code: 'sh518880', name: '黄金ETF华安', price: 8.617, prevClose: 8.474, changeRate: 1.69, quoteDate: '2026-10-10', quoteAt: '20261010150000' },
  { code: 'hk00700', name: '腾讯控股', price: 424.8, prevClose: 411.4, changeRate: 3.26, quoteDate: '2026-10-10', quoteAt: '2026-10-10 16:00:00' },
  { code: 'whHKDCNY', name: 'HKD人民币', price: 0.8525, prevClose: null, changeRate: null, quoteDate: '2026-10-10', quoteAt: '2026-10-10 16:00:00' },
]
const catalogQuotes = async (codes: string[]) => {
  const out = CATALOG.filter((q) => codes.includes(q.code))
  if (out.length === 0) throw new Error('行情接口返回空（可能改格式了或被限流）')
  return out
}
const fetchQuotes = vi.fn(catalogQuotes)
vi.mock('../../src/lib/quotes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/quotes.js')>()),
  fetchQuotes,
}))

const { shouldFetchQuotes, runScheduledTasks, runHousekeepingTasks, resetFxThrottle, intervalMinutes, processQuoteFetch } = await import('../../src/services/scheduler.js')
const { initDb, getDb } = await import('../../src/db/index.js')

describe('shouldFetchQuotes —— 只在盘中与收盘后抓', () => {
  /**
   * ⚠️ 一律用带 `Z` 的 **UTC 瞬时**，不用 `new Date('...T10:00:00')`。
   * 后者按**本地时区**解析——在 CST 机器上碰巧是对的，在 UTC 的 CI 上
   * 同一行会得到不同结果，测试就变成了「看跑在哪台机器上」。
   *
   * 北京 = UTC+8，所以北京 10:00 写作 `T02:00:00Z`。
   */
  const bj = (hhmm: string, date = '2026-10-09') => {
    const [h, m] = hhmm.split(':').map(Number)
    const utcH = h! - 8
    const day = utcH < 0 ? new Date(`${date}T00:00:00Z`).getTime() - 86400000 : new Date(`${date}T00:00:00Z`).getTime()
    const d = new Date(day)
    d.setUTCHours(((utcH % 24) + 24) % 24, m!, 0, 0)
    return d
  }

  it('盘中抓（上午/下午）', () => {
    expect(shouldFetchQuotes(bj('10:00')).fetch).toBe(true)
    expect(shouldFetchQuotes(bj('14:00')).fetch).toBe(true)
  })
  it('收盘后抓（这次最重要：收盘价是净资产的锚）', () => {
    expect(shouldFetchQuotes(bj('15:20')).fetch).toBe(true)
  })
  it('夜里不抓（跑同一个价只会伪造新鲜度）', () => {
    expect(shouldFetchQuotes(bj('22:00')).fetch).toBe(false)
    expect(shouldFetchQuotes(bj('03:00')).fetch).toBe(false)
  })
  it('周末不抓', () => {
    expect(shouldFetchQuotes(bj('10:00', '2026-10-10')).fetch).toBe(false)  // 周六
    expect(shouldFetchQuotes(bj('15:20', '2026-10-11')).fetch).toBe(false)  // 周日
  })
  it('午休不抓（11:35-12:55）', () => {
    expect(shouldFetchQuotes(bj('11:50')).fetch).toBe(false)
    expect(shouldFetchQuotes(bj('12:30')).fetch).toBe(false)
  })
  it('收盘后窗口结束就不再抓（15:45）', () => {
    expect(shouldFetchQuotes(bj('15:45')).fetch).toBe(false)
  })

  /* ⚠️ 这条专治「用服务器本地时间」那个 bug：
     容器跑在 UTC，若门禁用 getHours()，北京盘中会被判成非交易时段。 */
  it('按北京时间判断，不受服务器时区影响', () => {
    // 北京 2026-10-09 10:00 == UTC 02:00。容器在 UTC 时 getHours() 是 2，
    // 用本地时间会判成「非交易时段」；按北京时间必须判成盘中。
    expect(shouldFetchQuotes(new Date('2026-10-09T02:00:00Z')).reason).toBe('A股盘中')
    // 北京 18:00 == UTC 10:00。本地时间会误判成盘中。
    expect(shouldFetchQuotes(new Date('2026-10-09T10:00:00Z')).fetch).toBe(false)
  })

  /* ══════════════════════════════════════════════════════════
     三个市场时段不同——只按 A 股判断会让港股收盘价和美股永远抓不到。
     ══════════════════════════════════════════════════════════ */
  it('港股比 A 股晚收盘 1 小时（16:00）', () => {
    const hk = bj('16:20')   // A 股 15:40 就结束了
    expect(shouldFetchQuotes(hk, ['cn']).fetch).toBe(false)
    expect(shouldFetchQuotes(hk, ['hk']).fetch).toBe(true)
    // 只持港股时不看 A 股时段
    expect(shouldFetchQuotes(hk, ['hk']).reason).toContain('港股')
  })

  it('港股午休是 12:00-13:00，比 A 股晚半小时', () => {
    expect(shouldFetchQuotes(bj('12:10'), ['hk']).fetch).toBe(false)  // 港股午休
    expect(shouldFetchQuotes(bj('12:30'), ['cn']).fetch).toBe(false)  // A 股午休
    expect(shouldFetchQuotes(bj('11:50'), ['hk']).fetch).toBe(true)   // 港股还在交易
  })

  it('美股在北京夜里（21:30-次日 04:00）', () => {
    // 北京 22:00 = UTC 14:00
    const us = new Date('2026-10-09T14:00:00Z')
    expect(shouldFetchQuotes(us, ['cn']).fetch).toBe(false)   // A 股早收了
    expect(shouldFetchQuotes(us, ['us']).fetch).toBe(true)
    // 北京 02:00 = UTC 前一天 18:00
    expect(shouldFetchQuotes(new Date('2026-10-08T18:00:00Z'), ['us']).fetch).toBe(true)
  })

  /*
    美股跨午夜 ⇒ 北京凌晨那一段属于**前一个自然日**的美股交易日。
    周末判断如果不跟着跨，就会把北京周六凌晨（美东周五盘中，收盘价就在这一段）
    当成周末。A股/港股都在当天收盘，不受影响。
  */
  it('周末按**该市场自己的交易日**判：北京周六凌晨是美东周五盘中', () => {
    // 北京 2026-10-10 02:00（周六）= 美东 10-09 14:00（周五盘中）
    expect(shouldFetchQuotes(new Date('2026-10-09T18:00:00Z'), ['us']).fetch).toBe(true)
    // 同一天的 A 股确实是周末
    expect(shouldFetchQuotes(new Date('2026-10-09T18:00:00Z'), ['cn']).fetch).toBe(false)
    // 北京 2026-10-11 02:00（周日）= 美东 10-10 14:00（周六休市）
    expect(shouldFetchQuotes(new Date('2026-10-10T18:00:00Z'), ['us']).fetch).toBe(false)
    // 北京 2026-10-12 02:00（周一）= 美东 10-11 14:00（周日休市）
    expect(shouldFetchQuotes(new Date('2026-10-11T18:00:00Z'), ['us']).fetch).toBe(false)
  })

  it('多市场时任一开着就抓，并报出是哪个市场', () => {
    const hkOnly = bj('16:20')
    const r = shouldFetchQuotes(hkOnly, ['cn', 'hk'])
    expect(r.fetch).toBe(true)
    expect(r.market).toBe('hk')
  })

  it('北京跨日边界正确（UTC 前一天 16:30 = 北京次日 00:30）', () => {
    // 北京周六 00:30（UTC 周五 16:30）→ 周末，不抓
    expect(shouldFetchQuotes(new Date('2026-10-09T16:30:00Z')).fetch).toBe(false)
    // 北京周一 00:30（UTC 周日 16:30）→ 工作日但非交易时段
    expect(shouldFetchQuotes(new Date('2026-10-11T16:30:00Z')).reason).toBe('非交易时段')
  })
})

describe('beijingDate', () => {
  it('取北京日期而不是 UTC 日期', async () => {
    const { beijingDate } = await import('../../src/services/scheduler.js')
    // UTC 2026-10-09 16:30 = 北京 2026-10-10 00:30
    expect(beijingDate(new Date('2026-10-09T16:30:00Z'))).toBe('2026-10-10')
    expect(beijingDate(new Date('2026-10-09T15:59:00Z'))).toBe('2026-10-09')
  })
})

describe('调度间隔', () => {
  afterEach(() => { delete process.env.QUOTE_REFRESH_MINUTES })

  it('默认 15 分钟——小时级太粗，早上记的账一整天看不到浮盈变化', async () => {
    const { intervalMinutes: fn } = await import('../../src/services/scheduler.js')
    delete process.env.QUOTE_REFRESH_MINUTES
    expect(fn()).toBe(15)
  })

  it('可用 QUOTE_REFRESH_MINUTES 覆盖', () => {
    process.env.QUOTE_REFRESH_MINUTES = '5'
    expect(intervalMinutes()).toBe(5)
  })

  it('非法值回落到默认，不是 0（0 会让 setInterval 变成疯狂循环）', () => {
    for (const bad of ['0', '-3', 'abc', '']) {
      process.env.QUOTE_REFRESH_MINUTES = bad
      expect(intervalMinutes(), bad).toBe(15)
    }
  })
})

describe('同一时刻重复抓取不写重复行（调密的前提）', () => {
  it('同一 (code, quote_date, quoted_at) 只落一条', async () => {
    const { initDb } = await import('../../src/db/index.js')
    const { storeQuotes } = await import('../../src/lib/investments-repo.js')
    const db = initDb()
    db.exec('DELETE FROM investment_quotes')
    const q = {
      code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
      changeRate: 1.3, quoteDate: '2026-10-09', quoteAt: '2026-10-09 15:00:00',
    }
    storeQuotes(db, [q])
    storeQuotes(db, [q])   // 盘中 15 分钟一跳，同一个价会被抓很多次
    storeQuotes(db, [q])
    const n = (db.prepare('SELECT count(*) c FROM investment_quotes').get() as { c: number }).c
    expect(n).toBe(1)
  })
})

describe('runScheduledTasks 真的会调用行情抓取', () => {
  beforeEach(() => { fetchQuotes.mockClear(); resetFxThrottle() })

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
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))  // 北京 10:00（盘中）
    await runScheduledTasks()

    expect(fetchQuotes).toHaveBeenCalledTimes(1)
    expect(fetchQuotes).toHaveBeenCalledWith(['sh518880'])
    const rows = db.prepare('SELECT code, price FROM investment_quotes').all() as Array<{ code: string; price: number }>
    expect(rows).toEqual([{ code: 'sh518880', price: 8.617 }])
    vi.useRealTimers()
  })
})

describe('节假日识别（从数据推断，不维护日历）', () => {
  // 模块级缓存会跨用例残留：清掉，否则前一个用例标记的「今日休市」会拦住后一个
  beforeEach(async () => {
    const { resetMarketClosedCache } = await import('../../src/services/scheduler.js')
    resetMarketClosedCache()
  })

  /** 造一个只有某用户/账户/持仓的干净库 */
  async function seed(db: any, code = 'sh518880') {
    db.exec('DELETE FROM investments; DELETE FROM investment_quotes; DELETE FROM accounts; DELETE FROM users;')
    const uid = Number(db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES ('holiday', 'x', 'user')",
    ).run().lastInsertRowid)
    const acc = Number(db.prepare(
      "INSERT INTO accounts (user_id, name, asset_type) VALUES (?, '证券', 'investment')",
    ).run(uid).lastInsertRowid)
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, ?, 'X', 'sh', 'etf', 100)`,
    ).run(uid, acc, code)
  }

  it('盘中发现行情日期不是今天 → 认定今天休市，后续不再打接口', async () => {
    const { initDb } = await import('../../src/db/index.js')
    const { processQuoteFetch, marketClosedDate } = await import('../../src/services/scheduler.js')
    const db = initDb()
    await seed(db)
    // 行情日期停在 10-08，而"今天"是 10-09（周四）——典型节假日
    fetchQuotes.mockResolvedValueOnce([{
      code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
      changeRate: 1.3, quoteDate: '2026-10-08', quoteAt: '2026-10-08 15:00:00',
    }])
    vi.setSystemTime(new Date('2026-10-09T03:00:00Z'))  // 北京 11:00
    fetchQuotes.mockClear()

    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(1)
    expect(marketClosedDate('cn')).toBe('2026-10-09')

    // 本次跳再跑 → 不该再打接口
    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('行情日期就是今天 → 正常交易日，不标记休市', async () => {
    const { initDb } = await import('../../src/db/index.js')
    const { processQuoteFetch } = await import('../../src/services/scheduler.js')
    const db = initDb()
    await seed(db)
    fetchQuotes.mockResolvedValueOnce([{
      code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
      changeRate: 1.3, quoteDate: '2026-10-12', quoteAt: '2026-10-12 11:00:00',
    }])
    vi.setSystemTime(new Date('2026-10-12T03:00:00Z'))  // 北京 11:00（周一）
    fetchQuotes.mockClear()
    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(1)   // 打了接口
    // 不该误判休市：下一次仍然会抓
    fetchQuotes.mockResolvedValueOnce([{
      code: 'sh518880', name: 'ETF', price: 8.6, prevClose: 8.617,
      changeRate: -0.2, quoteDate: '2026-10-12', quoteAt: '2026-10-12 11:15:00',
    }])
    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('开盘初期（10:00 前）不下"休市"结论——可能只是日期还没切过来', async () => {
    const { initDb } = await import('../../src/db/index.js')
    const { processQuoteFetch, marketClosedDate } = await import('../../src/services/scheduler.js')
    const db = initDb()
    await seed(db)
    fetchQuotes.mockResolvedValueOnce([{
      code: 'sh518880', name: 'ETF', price: 8.617, prevClose: 8.5,
      changeRate: 1.3, quoteDate: '2026-10-13', quoteAt: '2026-10-13 15:00:00',
    }])
    vi.setSystemTime(new Date('2026-10-14T01:30:00Z'))  // 北京 09:30
    fetchQuotes.mockClear()
    await processQuoteFetch()
    expect(marketClosedDate('cn')).not.toBe('2026-10-14')  // 不标记
    vi.useRealTimers()
  })

  /*
    美股跨午夜：北京凌晨那一跳对应的美股交易日是**前一天**。
    若拿北京日期去比行情日期，凌晨拿到的「美东周一」行情会被读成
    「北京周二休市」，于是**整个周二晚上（美东周二盘中）被跳过**——
    收盘价永远抓不到，页面上的美股价格停在半夜那一瞬间。
  */
  it('美股：北京凌晨那一跳不得把当天（北京）判成休市，晚上还要照抓', async () => {
    const { initDb } = await import('../../src/db/index.js')
    const { processQuoteFetch, marketClosedDate } = await import('../../src/services/scheduler.js')
    const db = initDb()
    await seed(db, 'usAAPL')
    fetchQuotes.mockClear()

    // 北京 2026-10-13（周二）02:00 = 美东 10-12（周一）14:00，行情日期必然是周一
    fetchQuotes.mockResolvedValueOnce([{
      code: 'usAAPL', name: '苹果', price: 336.64, prevClose: 330,
      changeRate: 2.0, quoteDate: '2026-10-12', quoteAt: '2026-10-12 14:00:00',
    }])
    vi.setSystemTime(new Date('2026-10-12T18:00:00Z'))
    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(1)
    expect(marketClosedDate('us')).toBeNull()      // 不是「今天休市」

    // 北京 2026-10-13 22:00 = 美东 10-13（周二）10:00，盘中必须继续抓
    fetchQuotes.mockResolvedValueOnce([{
      code: 'usAAPL', name: '苹果', price: 340, prevClose: 336.64,
      changeRate: 1.0, quoteDate: '2026-10-13', quoteAt: '2026-10-13 10:00:00',
    }])
    vi.setSystemTime(new Date('2026-10-13T14:00:00Z'))
    await processQuoteFetch()
    expect(fetchQuotes).toHaveBeenCalledTimes(2)
    const rows = db.prepare("SELECT quote_date FROM investment_quotes WHERE code='usAAPL' ORDER BY quote_date").all()
    expect(rows).toEqual([{ quote_date: '2026-10-12' }, { quote_date: '2026-10-13' }])
    vi.useRealTimers()
  })
})

/* ══════════════════════════════════════════════════════════════
   汇率链路与失败事实（收敛到 quote-acquisition 之后的行为）
   ══════════════════════════════════════════════════════════════ */
describe('汇率任务走 FX 链路，来源不许硬编码', () => {
  /** 只留一个外币持仓（港股）的干净库 */
  function seedHk() {
    const db = initDb()
    db.exec('DELETE FROM investments; DELETE FROM investment_quotes; DELETE FROM accounts; DELETE FROM users;')
    const uid = Number(db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES ('fxuser', 'x', 'user')",
    ).run().lastInsertRowid)
    const acc = Number(db.prepare(
      "INSERT INTO accounts (user_id, name, asset_type) VALUES (?, '港股账户', 'investment')",
    ).run(uid).lastInsertRowid)
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'hk00700', '腾讯', 'hk', 'stock', 100)`,
    ).run(uid, acc)
    return db
  }

  beforeEach(async () => {
    const { resetMarketClosedCache } = await import('../../src/services/scheduler.js')
    resetMarketClosedCache()
    resetFxThrottle()
    fetchQuotes.mockClear()
  })

  it('外币持仓：定时任务既抓行情也抓汇率，汇率行带**真实**来源与行情日期', async () => {
    const db = seedHk()
    // 北京 10:00（港/A 股盘中）
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
    await runScheduledTasks()
    vi.useRealTimers()

    // 股价与汇率是两次上游请求（汇率自己走主源→兜底链）
    const calls = fetchQuotes.mock.calls.map((c) => (c as unknown as string[][])[0])
    expect(calls).toContainEqual(['hk00700'])
    expect(calls).toContainEqual(['whHKDCNY'])

    const fxRows = db.prepare(
      "SELECT code, price, source, quote_date FROM investment_quotes WHERE code LIKE 'wh%'",
    ).all() as Array<{ code: string; price: number; source: string; quote_date: string }>
    // ⚠️ 以前 storeQuotes 写死 source='tencent'，兜底源拿到的也标成腾讯
    expect(fxRows).toEqual([
      { code: 'whHKDCNY', price: 0.8525, source: 'tencent', quote_date: '2026-10-10' },
    ])
    // 股价也真的落库了
    expect(db.prepare("SELECT count(*) c FROM investment_quotes WHERE code = 'hk00700'").get())
      .toEqual({ c: 1 })
  })

  it('行情抓取失败：一行都不写、也不抛（等下一次跳再试）', async () => {
    const db = seedHk()
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))   // 北京 10:00，门禁开着
    fetchQuotes.mockRejectedValueOnce(new Error('行情接口返回 429'))
    await expect(processQuoteFetch()).resolves.toBeUndefined()
    vi.useRealTimers()

    // 汇率不写（这条只测股价路径，processFxRateFetch 没跑）
    expect(db.prepare('SELECT count(*) c FROM investment_quotes').get()).toEqual({ c: 0 })
  })

  it('部分代码上游没给：不抛，只是没那些行（不会整个失败）', async () => {
    const db = seedHk()
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       SELECT user_id, account_id, 'hk0100', '不认的', 'hk', 'stock', 1 FROM investments LIMIT 1`,
    ).run()
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
    await expect(processQuoteFetch()).resolves.toBeUndefined()
    vi.useRealTimers()

    expect(db.prepare("SELECT count(*) c FROM investment_quotes WHERE code = 'hk00700'").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT count(*) c FROM investment_quotes WHERE code = 'hk0100'").get()).toEqual({ c: 0 })
  })

  it('汇率按 FX_REFRESH_MINUTES 节流，行情不受影响', async () => {
    const db = seedHk()
    // 北京 09:50：开盘但未到 10:00，不会把夹具里的行情日期误判成「今天休市」
    vi.setSystemTime(new Date('2026-10-09T01:50:00Z'))
    await runScheduledTasks()
    fetchQuotes.mockClear()
    await runScheduledTasks()

    expect(fetchQuotes).not.toHaveBeenCalledWith(['whHKDCNY'])
    expect(fetchQuotes).toHaveBeenCalledWith(['hk00700'])
    vi.useRealTimers()
  })
})

describe('审查回归：调度失败隔离、日志留存与冬夏令时', () => {
  const scheduler = () => import('../../src/services/scheduler.js')
  let db: ReturnType<typeof getDb>
  let userId: number

  beforeEach(async () => {
    vi.useFakeTimers()
    // 北京 09:50：开盘但未到 10:00，避免夹具里的行情日期被误判成「今天休市」
    vi.setSystemTime(new Date('2026-10-09T01:50:00Z'))
    db = initDb()
    userId = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('scheduler_regression', 'x')").run().lastInsertRowid)
    const accountId = Number(db.prepare("INSERT INTO accounts (user_id, name) VALUES (?, '证券')").run(userId).lastInsertRowid)
    db.prepare("INSERT INTO investments (user_id, account_id, code, market, kind, quantity) VALUES (?, ?, 'hk00700', 'hk', 'stock', 1)").run(userId, accountId)
    fetchQuotes.mockReset().mockImplementation(catalogQuotes)
    ;(await scheduler()).resetMarketClosedCache()
    ;(await scheduler()).resetFxThrottle()
  })

  afterEach(async () => {
    ;(await scheduler()).stopScheduler()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    fetchQuotes.mockReset().mockImplementation(catalogQuotes)
    db.close()
  })

  const count = (db: ReturnType<typeof getDb>, table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  it('90天清理保留有裁决日志及全部改判历史，删除无裁决旧日志，后续任务仍运行', async () => {
    const insertLog = db.prepare("INSERT INTO ai_parse_logs (user_id, raw_input, status, created_at) VALUES (?, '测试', 'empty', ?)")
    const retained = Number(insertLog.run(userId, '2026-01-01 00:00:00').lastInsertRowid)
    insertLog.run(userId, '2026-01-01 00:00:00')
    const recent = Number(insertLog.run(userId, '2026-10-08 00:00:00').lastInsertRowid)
    const boundary = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    const atCutoff = Number(insertLog.run(userId, boundary).lastInsertRowid)
    const triage = db.prepare('INSERT INTO admin_unparsed_triage (parse_log_id, admin_id, action, reason) VALUES (?, ?, ?, ?)')
    triage.run(retained, userId, 'mark_bill', '首次裁决')
    triage.run(retained, userId, 'mark_not_bill', '改判')
    const history = db.prepare('SELECT * FROM admin_unparsed_triage').all()
    db.prepare("INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, 'old', 'user', '旧对话', '2026-01-01')").run(userId)
    db.prepare("INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, created_at) VALUES (?, '旧预筛', 'inbound', 0, '2026-01-01')").run(userId)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

    await expect(runHousekeepingTasks()).resolves.toBeUndefined()
    await expect(runScheduledTasks()).resolves.toBeUndefined()

    expect(db.prepare('SELECT id FROM ai_parse_logs ORDER BY id').all()).toEqual([{ id: retained }, { id: recent }, { id: atCutoff }])
    expect(db.prepare('SELECT * FROM admin_unparsed_triage').all()).toEqual(history)
    expect(count(db, 'ai_conversations')).toBe(0)
    expect(count(db, 'ai_parse_filters')).toBe(0)
    expect(fetchQuotes).toHaveBeenCalledWith(['whHKDCNY'])
    expect(fetchQuotes).toHaveBeenCalledWith(['hk00700'])
  })

  it.each(['订阅', '回收站', '日志'])('%s子任务抛错仍执行后续清理、汇率与行情', async (task) => {
    if (task === '订阅') db.exec('DROP TABLE subscriptions')
    if (task === '回收站') {
      db.prepare("INSERT INTO transactions (user_id, type, amount, date, deleted_at) VALUES (?, 'expense', 100, '2026-01-01', '2026-01-02')").run(userId)
      db.exec("CREATE TRIGGER reject_trash BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'cleanup fault'); END")
    }
    if (task === '日志') {
      db.exec("INSERT INTO app_logs (level, module, message, created_at) VALUES ('info', 'test', 'old', '2026-01-01')")
      db.exec("CREATE TRIGGER reject_log BEFORE DELETE ON app_logs BEGIN SELECT RAISE(ABORT, 'cleanup fault'); END")
    }
    db.prepare("INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, 'old', 'user', '旧对话', '2026-01-01')").run(userId)

    await expect(runHousekeepingTasks()).resolves.toBeUndefined()
    await expect(runScheduledTasks()).resolves.toBeUndefined()

    if (task !== '日志') expect(count(db, 'ai_conversations')).toBe(0)
    expect(fetchQuotes).toHaveBeenCalledWith(['whHKDCNY'])
    expect(fetchQuotes).toHaveBeenCalledWith(['hk00700'])
    const errors = db.prepare("SELECT message FROM app_logs WHERE module = 'scheduler' AND level IN ('warn', 'error')").all() as Array<{ message: string }>
    expect(errors.some((r) => r.message.includes(task))).toBe(true)
  })

  it.each(['acquireAndStoreFxRates', 'acquireAndStorePrices'] as const)('%s拒绝不影响其它子任务，下一跳可恢复', async (method) => {
    const acquisition = await import('../../src/lib/quote-acquisition.js')
    vi.spyOn(acquisition, method).mockRejectedValueOnce(new Error('acquisition fault'))
    const log = vi.spyOn(await import('../../src/services/logger.js'), 'appLog')
    db.prepare("INSERT INTO ai_conversations (user_id, session_id, role, content, created_at) VALUES (?, 'old', 'user', '旧对话', '2026-01-01')").run(userId)
    await expect(runHousekeepingTasks()).resolves.toBeUndefined()
    await expect(runScheduledTasks()).resolves.toBeUndefined()
    expect(count(db, 'ai_conversations')).toBe(0)
    expect(fetchQuotes).toHaveBeenCalledWith(method === 'acquireAndStoreFxRates' ? ['hk00700'] : ['whHKDCNY'])
    expect(log).toHaveBeenCalledWith('warn', 'scheduler', expect.stringContaining('acquisition fault'))
    resetFxThrottle()
    await expect(runScheduledTasks()).resolves.toBeUndefined()
    expect(fetchQuotes).toHaveBeenCalledWith(['whHKDCNY'])
    expect(fetchQuotes).toHaveBeenCalledWith(['hk00700'])
  })

  it('启动与周期timer都捕获顶层拒绝并记录，不留下未处理Promise', async () => {
    const { startScheduler } = await scheduler()
    const logger = await import('../../src/services/logger.js')
    const realLog = logger.appLog
    const log = vi.spyOn(logger, 'appLog').mockImplementation((level, module, message, data) => {
      if (message === '定时任务开始执行') throw new Error('timer fault')
      realLog(level, module, message, data)
    })
    startScheduler()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(intervalMinutes() * 60000 - 5000)
    const failures = log.mock.calls.filter(([level, module, message]) => level === 'error' && module === 'scheduler' && message.includes('timer fault'))
    expect(failures).toHaveLength(2)
  })

  it('冬令时北京22点旧价不能封住23点的当日行情', async () => {
    db.exec("UPDATE investments SET code = 'usAAPL', market = 'us'")
    fetchQuotes.mockImplementation(async () => [{
      code: 'usAAPL', name: '苹果', price: 200, prevClose: 199, changeRate: 0.5,
      quoteDate: fetchQuotes.mock.calls.length === 1 ? '2026-12-07' : '2026-12-08',
      quoteAt: fetchQuotes.mock.calls.length === 1 ? '2026-12-07 16:00:00' : '2026-12-08 10:00:00',
    }])
    const { marketClosedDate } = await scheduler()
    await processQuoteFetch(new Date('2026-12-08T14:00:00Z')) // 北京22点 = 纽约09点
    const closedBeforeOpen = marketClosedDate('us')
    await processQuoteFetch(new Date('2026-12-08T15:00:00Z')) // 北京23点 = 纽约10点
    expect(fetchQuotes).toHaveBeenCalledTimes(2)
    expect(closedBeforeOpen).toBeNull()
    expect(marketClosedDate('us')).toBeNull()
    expect(db.prepare("SELECT quote_date FROM investment_quotes WHERE code = 'usAAPL' ORDER BY quote_date").all())
      .toEqual([{ quote_date: '2026-12-07' }, { quote_date: '2026-12-08' }])
  })

  it.each([
    ['2026-10-13T14:00:00Z', '2026-10-13', '2026-10-12'],
    ['2026-12-08T15:00:00Z', '2026-12-08', '2026-12-07'],
  ])('纽约10点可确认休市（%s），冬夏令时一致', async (now, tradingDate, oldDate) => {
    db.exec("UPDATE investments SET code = 'usAAPL', market = 'us'")
    fetchQuotes.mockResolvedValue([{
      code: 'usAAPL', name: '苹果', price: 200, prevClose: 199, changeRate: 0.5,
      quoteDate: oldDate, quoteAt: `${oldDate} 16:00:00`,
    }])
    await processQuoteFetch(new Date(now))
    expect((await scheduler()).marketClosedDate('us')).toBe(tradingDate)
    await processQuoteFetch(new Date(now))
    expect(fetchQuotes).toHaveBeenCalledTimes(1)
  })
})
