/**
 * quote-acquisition module：抓取 → 落库 → 降级事实。
 *
 * 这个 module 存在的理由是**副作用顺序与失败语义**以前散在五个调用点，
 * 各写各的（静默 / 回响应 / 记日志 / 什么都不做），汇率那条甚至绕过了 ECB 兜底。
 * 所以这里测的不是「能不能拿到价」，而是：
 *   1. **失败一行都不写**（写一条错价比不写更危险）
 *   2. **降级事实可判定**（区分「接口挂了」与「代码不认」）
 *   3. **来源不撒谎**（ECB 补的汇率在库里必须标 ecb，不能硬编码 tencent）
 *   4. **后台补汇率有闸门**（先同步盖 60s cooldown 时间戳；窗口覆盖最坏超时，
 *      因此无需 single-flight，也不会变成请求放大器）
 *
 * 上游全部离线：腾讯接口 mock 在 `src/lib/quotes.js`，ECB 走 stub 的全局 fetch。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/lib/quotes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/quotes.js')>()),
  fetchQuotes: vi.fn(),
}))

const quotesModule = await import('../../src/lib/quotes.js')
const fetchQuotes = vi.mocked(quotesModule.fetchQuotes)
const { QuoteFetchError } = quotesModule
const { acquireAndStorePrices, acquireAndStoreFxRates, backfillFxRates, resetFxBackfillState, FX_BACKFILL_COOLDOWN_MS } =
  await import('../../src/lib/quote-acquisition.js')
const { initDb, getDb } = await import('../../src/db/index.js')

const TENCENT = (code: string, price: number, quoteDate = '2026-10-09') => ({
  code, name: code, price, prevClose: price, changeRate: null,
  quoteDate, quoteAt: `${quoteDate} 15:00:00`,
})

/** fx 行：腾讯格式，段[3]=汇率、段[5]=时间戳 */
const fxLine = (ccy: string, rate: number) =>
  `v_wh${ccy}CNY="310~${ccy}~${ccy}CNY~${rate}~0~20261009160000~${rate}~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0"`
const gbkBody = (lines: string[]) => new TextEncoder().encode(lines.join('\n'))

function quoteRows(code: string) {
  return getDb()
    .prepare('SELECT price, quote_date, source FROM investment_quotes WHERE code = ?')
    .all(code) as Array<{ price: number; quote_date: string; source: string }>
}

describe('acquireAndStorePrices', () => {
  beforeEach(() => {
    initDb()
    getDb().exec('DELETE FROM investment_quotes')
    fetchQuotes.mockReset()
    resetFxBackfillState()
  })

  it('成功：归一 → 落库 → 返回可判定的结果', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('sh518880', 8.617)])
    const db = getDb()
    const r = await acquireAndStorePrices(db, ['518880', '518880'])   // 重复的会去重

    expect(fetchQuotes).toHaveBeenCalledWith(['sh518880'])          // 归一只做一次
    expect(r.stored).toBe(1)
    expect(r.reachable).toBe(true)
    expect(r.unknown).toEqual([])
    expect(r.degraded).toEqual([])
    expect(r.byCode.get('sh518880')!.price).toBe(8.617)
    expect(quoteRows('sh518880')).toEqual([
      { price: 8.617, quote_date: '2026-10-09', source: 'tencent' },
    ])
  })

  it('部分不认：认识的照写、不认的进 unknown（**不是**失败）', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('sh518880', 8.617)])
    const r = await acquireAndStorePrices(getDb(), ['sh518880', 'hk0100'])

    expect(r.reachable).toBe(true)
    expect(r.unknown).toEqual(['hk0100'])
    expect(r.degraded.map((d) => d.code)).toEqual(['unknown_codes'])
    expect(quoteRows('sh518880')).toHaveLength(1)
  })

  it('一个都没解析出来：reachable=false + empty_response，且**一行都不写**', async () => {
    // ⚠️ 必须是**真实的 typed 错误**：mock 里抛普通 Error 会走一条生产中不存在的分类路径
    fetchQuotes.mockRejectedValue(
      new QuoteFetchError('empty_response', '行情接口返回空（可能改格式了或被限流）'))
    const r = await acquireAndStorePrices(getDb(), ['hk0100', 'sz000001'])

    expect(r.reachable).toBe(false)
    expect(r.unknown).toEqual(['hk0100', 'sz000001'])
    expect(r.degraded.map((d) => d.code)).toEqual(['empty_response', 'unknown_codes'])
    expect(getDb().prepare('SELECT count(*) c FROM investment_quotes').get()).toEqual({ c: 0 })
  })

  it('限流/非 2xx 与「连不上」分开记（对用户的建议完全不同）', async () => {
    fetchQuotes.mockRejectedValue(new QuoteFetchError('upstream_status', '行情接口返回 429', 429))
    const limited = await acquireAndStorePrices(getDb(), ['sh518880'])
    expect(limited.degraded[0]!.code).toBe('upstream_status')
    expect(limited.degraded[0]!.detail).toContain('429')

    fetchQuotes.mockRejectedValue(new Error('fetch failed'))
    const down = await acquireAndStorePrices(getDb(), ['sh518880'])
    expect(down.degraded[0]!.code).toBe('upstream_unreachable')
    expect(getDb().prepare('SELECT count(*) c FROM investment_quotes').get()).toEqual({ c: 0 })
  })

  /**
   * 分类靠 `instanceof QuoteFetchError`，**不许**再去猜文案。
   * 这条是「反字符串匹配」守卫：文案里写着「返回空」但不是 typed 错误，
   * 归类必须仍然是 upstream_unreachable——以前在 sibling 模块里找 `/返回空/`，
   * 那句话一改，降级分类就静默变味。
   */
  it('分类看类型不看文案：普通 Error 即使写着「返回空」也只算不可达', async () => {
    fetchQuotes.mockRejectedValue(new Error('行情接口返回空（可能改格式了或被限流）'))
    const r = await acquireAndStorePrices(getDb(), ['sh518880'])
    expect(r.reachable).toBe(false)
    expect(r.degraded[0]!.code).toBe('upstream_unreachable')     // 不是 empty_response
    expect(r.degraded[0]!.detail).toContain('返回空')             // 文案还在，但不再决定分类
  })

  it('empty_response 只来自 typed 错误（有 kind 的才算）', async () => {
    fetchQuotes.mockRejectedValue(new QuoteFetchError('empty_response', '行情接口返回空'))
    const r = await acquireAndStorePrices(getDb(), ['sh518880'])
    expect(r.degraded[0]!.code).toBe('empty_response')
    expect(r.degraded[0]!.detail).toBe('行情接口返回空')
  })

  it('空代码列表：不发请求、不写库', async () => {
    const r = await acquireAndStorePrices(getDb(), [])
    expect(fetchQuotes).not.toHaveBeenCalled()
    expect(r.stored).toBe(0)
  })
})

describe('acquireAndStoreFxRates —— 来源与新鲜度不许撒谎', () => {
  let ecbCalls: string[]
  beforeEach(() => {
    initDb()
    getDb().exec('DELETE FROM investment_quotes')
    fetchQuotes.mockReset()
    resetFxBackfillState()
    ecbCalls = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      ecbCalls.push(url)
      // ECB 返回「1 CNY = 多少外币」，且自带 date
      return new Response(JSON.stringify({ date: '2026-01-02', rates: { USD: 0.14943 } }), { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('主源命中：用行情自带日期与真实来源，不用「今天」', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('whHKDCNY', 0.8525)])
    const r = await acquireAndStoreFxRates(getDb(), ['HKD'])

    expect(r.source).toBe('tencent')
    expect(r.provenance.get('HKD')).toBe('tencent')
    expect(ecbCalls).toHaveLength(0)                        // 主源够用就不打兜底
    // 夹具的行情日期是 2026-10-09，而不是「今天」——不伪造新鲜度
    expect(quoteRows('whHKDCNY')).toEqual([
      { price: 0.8525, quote_date: '2026-10-09', source: 'tencent' },
    ])
  })

  it('主源缺一部分：兜底补上，汇总是 mixed，两行的 source 各归各位', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('whHKDCNY', 0.8525)])   // 没有 whUSDCNY
    const r = await acquireAndStoreFxRates(getDb(), ['HKD', 'USD'])

    expect(r.source).toBe('mixed')                              // 旧实现这里谎报 'tencent'
    expect(r.provenance.get('HKD')).toBe('tencent')
    expect(r.provenance.get('USD')).toBe('ecb')
    expect(r.missing).toEqual([])
    expect(quoteRows('whHKDCNY')[0]!.source).toBe('tencent')
    // ECB 那条用它**自己的** date，且倒数换算成「1 外币 = 多少人民币」
    expect(quoteRows('whUSDCNY')).toEqual([
      { price: 1 / 0.14943, quote_date: '2026-01-02', source: 'ecb' },
    ])
  })

  it('主源整个挂掉：全部走兜底，source=ecb', async () => {
    fetchQuotes.mockRejectedValue(new Error('行情接口返回空'))
    const r = await acquireAndStoreFxRates(getDb(), ['USD'])
    expect(r.source).toBe('ecb')
    expect(quoteRows('whUSDCNY')[0]!.source).toBe('ecb')
  })

  it('两个源都挂：missing 非空、带上失败原因，且**不写旧值**', async () => {
    fetchQuotes.mockRejectedValue(new Error('行情接口返回空'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECB 挂了') }))
    const r = await acquireAndStoreFxRates(getDb(), ['USD'])

    expect(r.source).toBe('none')
    expect(r.missing).toEqual(['USD'])
    expect(r.degraded.map((d) => d.code)).toEqual(['fx_missing'])
    expect(r.errors.join()).toContain('ECB 挂了')            // 唯一的诊断线索
    expect(quoteRows('whUSDCNY')).toHaveLength(0)
  })

  it('人民币 / 不支持的币种：不发请求、不写库', async () => {
    const r = await acquireAndStoreFxRates(getDb(), ['CNY'])
    expect(fetchQuotes).not.toHaveBeenCalled()
    expect(ecbCalls).toHaveLength(0)
    expect(r.stored).toBe(0)
  })
})

describe('backfillFxRates —— 后台补齐必须自带闸门', () => {
  beforeEach(() => {
    initDb()
    getDb().exec('DELETE FROM investment_quotes')
    fetchQuotes.mockReset()
    resetFxBackfillState()
    // 主源挂了会落到 ECB 兜底；这里把兜底也自己接管，不许真外发
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECB 挂了') }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('并发两次只发一次上游（先同步盖戳，窗口内不再发）', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('whHKDCNY', 0.8525)])
    const db = getDb()
    const [a, b] = await Promise.all([backfillFxRates(db, ['HKD']), backfillFxRates(db, ['HKD'])])

    const attempts = [a, b].filter((x) => x.attempted.length > 0)
    expect(attempts).toHaveLength(1)                          // 只有一次真的去取
    const skipped = [a, b].filter((x) => x.skipped.length > 0)
    expect(skipped).toHaveLength(1)
    expect(fetchQuotes).toHaveBeenCalledTimes(1)
  })

  it('刚试过就跳过（冷却）：失败也不立刻重试，不是请求放大器', async () => {
    fetchQuotes.mockRejectedValue(new Error('行情接口返回空'))
    const db = getDb()
    const first = await backfillFxRates(db, ['HKD'])
    expect(first.attempted).toEqual(['HKD'])

    const second = await backfillFxRates(db, ['HKD'])
    expect(second.attempted).toEqual([])
    expect(second.skipped).toEqual(['HKD'])
    expect(second.acquisition).toBeNull()
    expect(fetchQuotes).toHaveBeenCalledTimes(1)              // 没有第二次外发

    // 冷却窗口过去（或被重置）之后才允许再试
    resetFxBackfillState()
    await backfillFxRates(db, ['HKD'])
    expect(fetchQuotes).toHaveBeenCalledTimes(2)
  })

  it('CNY 不会被当成待补币种', async () => {
    const r = await backfillFxRates(getDb(), ['CNY'])
    expect(r.attempted).toEqual([])
    expect(fetchQuotes).not.toHaveBeenCalled()
  })

  it('主动触发的路径不受闸门影响：显式入口每次都真去取', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('whHKDCNY', 0.8525)])
    const db = getDb()
    await backfillFxRates(db, ['HKD'])                          // 第一次：取
    await acquireAndStoreFxRates(db, ['HKD'])                   // 显式：不受冷却影响
    expect(fetchQuotes).toHaveBeenCalledTimes(2)
  })

  /**
   * L4 的前提：**先同步盖 60s cooldown 时间戳、再发请求，且窗口覆盖最坏超时，
   * 因此无需 single-flight**（第二个调用必然撞在冷却上，不可能与第一次重叠）。
   *
   * 这条守卫把那个下界钉死：谁把窗口调小（或把超时调大），用例就红，
   * 提示他「那时才真需要 inFlight」。
   */
  it('冷却窗口 > 一次尝试的最坏超时（主源超时 + 兜底源超时）', async () => {
    const { QUOTES_TIMEOUT_MS } = await import('../../src/lib/quotes.js')
    const { ECB_TIMEOUT_MS } = await import('../../src/lib/fx.js')
    expect(QUOTES_TIMEOUT_MS).toBeGreaterThan(0)
    expect(ECB_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FX_BACKFILL_COOLDOWN_MS).toBeGreaterThan(QUOTES_TIMEOUT_MS + ECB_TIMEOUT_MS)
  })

  /**
   * L5：`stored` 必须是**真正落库的行数**，不是「抓到几条」。
   * UNIQUE(code, quote_date, quoted_at) 去重掉的那些不能算写入——
   * 否则日志里「汇率已更新 N 个」会说谎（同一行被数成两次）。
   */
  it('stored = 实际写入行数：重复抓同一行第二次记 0', async () => {
    fetchQuotes.mockResolvedValue([TENCENT('sh518880', 8.617)])
    const db = getDb()

    const first = await acquireAndStorePrices(db, ['sh518880'])
    expect(first.stored).toBe(1)

    const second = await acquireAndStorePrices(db, ['sh518880'])
    expect(second.quotes).toHaveLength(1)              // 抓是抓到了
    expect(second.stored).toBe(0)                      // 但一行没写进去
    expect((db.prepare('SELECT count(*) c FROM investment_quotes').get() as { c: number }).c).toBe(1)
  })

  it('storeQuotes 直接返回 changes（旧调用方忽略返回值即可）', async () => {
    const { storeQuotes } = await import('../../src/lib/investments-repo.js')
    const db = getDb()
    const row = TENCENT('sz159937', 8.5)
    expect(storeQuotes(db, [row])).toBe(1)
    expect(storeQuotes(db, [row])).toBe(0)             // 去重
    expect(storeQuotes(db, [row, { ...row }])).toBe(0) // 同一批里两条一样的也只算一次
    expect(storeQuotes(db, [])).toBe(0)
    expect((db.prepare('SELECT count(*) c FROM investment_quotes').get() as { c: number }).c).toBe(1)
  })
})

describe('quote 响应格式仍由 provider 决定（回归）', () => {
  it('GBK 的外汇响应能被解析成行情（parseFx 不被静默丢掉）', async () => {
    initDb()
    getDb().exec('DELETE FROM investment_quotes')
    fetchQuotes.mockImplementation(async () => {
      const { parseQuoteResponse } = quotesModule
      return parseQuoteResponse(new TextDecoder('gbk').decode(gbkBody([fxLine('HKD', 0.8527)])))
    })
    const r = await acquireAndStoreFxRates(getDb(), ['HKD'])
    expect(r.rates.get('HKD')).toBe(0.8527)
  })
})
