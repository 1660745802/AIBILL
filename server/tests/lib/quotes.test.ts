/**
 * 行情解析层单元测试
 *
 * 用真实抓到的响应片段（GBK 解码后）当夹具，不联网跑。
 * 三条重点：千分位/时间戳取自实际返回、`~` 与 `,` 两种格式必须分开、
 * 快照日期必须来自行情而不是「今天」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeCode, parseQuoteResponse, parseQuoteLine, fetchQuotes, QuoteFetchError } from '../../src/lib/quotes.js'

import { readFileSync } from 'node:fs'
import { currencyOf, fxCodesFor, toIsoDateTime } from '../../src/lib/quotes.js'
import { valueHolding, groupByAccount } from '../../src/lib/holdings.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 夹具是**真实抓取**的响应（tests/fixtures/quotes-sample.txt，GBK 已解码）。
 * 不用手搓字符串：腾讯的字段是 88 段，手写一段数错位就是假绿。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = readFileSync(join(HERE, '../fixtures/quotes-sample.txt'), 'utf-8')
const lineOf = (code: string) => SAMPLE.split('\n').find((l) => l.startsWith(`v_${code}=`))!

describe('normalizeCode', () => {
  it('纯 6 位数字按首位判断沪深', () => {
    expect(normalizeCode('518880')).toBe('sh518880')  // 5 开头 → 沪
    expect(normalizeCode('159937')).toBe('sz159937')  // 1 开头 → 深
    expect(normalizeCode('600519')).toBe('sh600519')
    expect(normalizeCode('000001')).toBe('sz000001')
  })
  it('已带市场前缀的不动', () => {
    expect(normalizeCode('sh518880')).toBe('sh518880')
    expect(normalizeCode('  SZ159937 ')).toBe('sz159937')
    expect(normalizeCode('hf_XAU')).toBe('hf_XAU')
  })
  it('5 位当港股、字母当美股', () => {
    expect(normalizeCode('00700')).toBe('hk00700')
    expect(normalizeCode('AAPL')).toBe('usAAPL')
  })
})

describe('parseQuoteResponse', () => {
  it('解析 ETF：现价/昨收/涨跌幅/行情日期', () => {
    const [q] = parseQuoteResponse(lineOf('sh518880'))!
    expect(q!.code).toBe('sh518880')
    expect(q!.name).toBe('黄金ETF华安')
    expect(q!.price).toBe(8.617)
    expect(q!.prevClose).toBe(8.474)
    expect(q!.changeRate).toBe(1.69)
    // 日期来自行情时间戳，不是「今天」
    expect(q!.quoteDate).toBe('2026-10-09')
  })

  it('一次响应里多条都能解析', () => {
    const qs = parseQuoteResponse(SAMPLE)
    // 保留响应里的原始大小写：code 是 holdings 里查 Map 的 key，
    // 小写化会让港股指数/美股永远查不到（`hf_XAU` 也是同理）
    expect(qs.map((q) => q.code).sort()).toEqual(['hf_XAU', 'sh000300', 'sh518880'])
  })

  it('~ 与 , 两种格式分开解析（外盘字段位置完全不同）', () => {
    const g = parseQuoteResponse(lineOf('hf_XAU'))![0]!
    expect(g.code).toBe('hf_XAU')
    expect(g.price).toBe(4194.39)
    expect(g.quoteDate).toBe('2026-10-10')
  })

  it('同一次响应里不同市场的行情日期可以不同——这正是不能用「今天」的原因', () => {
    const byCode = new Map(parseQuoteResponse(SAMPLE).map((q) => [q.code, q]))
    // 真实抓取的那一次：两个 A股标的停在 10-09 收盘，伦敦金已经是 10-10
    expect(byCode.get('sh518880')!.quoteDate).toBe('2026-10-09')
    expect(byCode.get('sh000300')!.quoteDate).toBe('2026-10-09')
    expect(byCode.get('hf_XAU')!.quoteDate).toBe('2026-10-10')
  })

  it('脏数据返回 null 而不是半个对象', () => {
    expect(parseQuoteLine('v_sh000001=""')).toBeNull()
    expect(parseQuoteLine('v_sh000001="1~名称~代码~abc~1~1"')).toBeNull()  // 价格非数字
    expect(parseQuoteLine('v_sh000001="1~名称~代码~8.6~1~1"')).toBeNull()  // 段数不够
    expect(parseQuoteLine('垃圾行')).toBeNull()
  })

  it('价格为 0 视为无效（停牌/退市）', () => {
    const line = lineOf('sh518880').replace('~8.617~', '~0.000~')
    expect(parseQuoteResponse(line)).toHaveLength(0)
  })
})

describe('fetchQuotes · 全部代码取不到时显式抛错', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // 用 GBK 编码一段「全是空 v_xxx=""」的响应（腾讯对不存在/退市的代码就这么回）
  function gbkBody(text: string): ArrayBuffer {
    // 这段响应全是 ASCII，GBK 与 UTF-8 一致，直接按字节数组返回
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(0, bytes.byteLength)
  }

  it('所有代码都返回空段 → 抛 QuoteFetchError(kind=empty_response)', async () => {
    // 写错的代码 / 退市：腾讯回 v_sh999999="";
    const body = 'v_sh999999="";\nv_sz888888="";\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => gbkBody(body),
    })))
    const err = await fetchQuotes(['999999', '888888']).catch((e: unknown) => e)
    // 文案仍在（给人看），但**分类靠 kind**——上游文案变了也不会走偏
    expect(err).toBeInstanceOf(QuoteFetchError)
    expect((err as QuoteFetchError).kind).toBe('empty_response')
    expect((err as Error).message).toMatch(/返回空/)
  })

  it('接口非 200 → QuoteFetchError(kind=upstream_status, status)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      arrayBuffer: async () => new ArrayBuffer(0),
    })))
    const err = await fetchQuotes(['518880']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(QuoteFetchError)
    expect((err as QuoteFetchError).kind).toBe('upstream_status')
    expect((err as QuoteFetchError).status).toBe(429)
    expect((err as Error).message).toMatch(/429/)
  })

  /**
   * 网络异常**不被包装**：调用方判定「不是 QuoteFetchError ⇒ 不可达」，
   * 原始错误（DNS/连接/中断）的身份得留着才好排查。
   */
  it('网络层异常不是 QuoteFetchError（上游不可达）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const err = await fetchQuotes(['518880']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(QuoteFetchError)
  })

  it('空代码列表直接返回空数组，不发请求也不抛错', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(fetchQuotes([])).resolves.toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

/* ── 港股 / 美股 ──
   这两个市场的响应结构和 A 股**不同**，不是"也支持一下"那么简单：
     段数        78（A 股 88）
     field[30]   `2026/10/09 16:08:14`（A 股是紧凑的 20261009161456）
   原来只认紧凑格式 → 港股一条都解析不出来，上层只看到「接口返回空」。
   而且代码**大小写敏感**：`hkHSI` 通而 `hkhsi` 不通，`usAAPL` 通而 `usaapl` 不通。
   夹具是真实抓取的响应（GBK 已解码）。 */
describe('港股 / 美股（真实响应夹具）', () => {
  const SAMPLE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../fixtures/quotes-hk-us-sample.txt'),
    'utf-8',
  )
  const parsed = parseQuoteResponse(SAMPLE)

  it('三种代码写法都规范到腾讯认的形式', () => {
    expect(normalizeCode('00700')).toBe('hk00700')       // 5 位
    expect(normalizeCode('0700')).toBe('hk00700')        // 4 位省略前导零
    expect(normalizeCode('00700.HK')).toBe('hk00700')     // 带后缀
    expect(normalizeCode('hk00700')).toBe('hk00700')     // 已规范不重复加前缀
    expect(normalizeCode('518880')).toBe('sh518880')     // A 股不受影响
    // 黄金：腾讯只认 hf_XAU（全大写），hf_xau 返回 pv_none_match。
    // normalizeCode 必须产出和响应 key 一致的写法，否则 Map 对不上 → 永远「未取到价」
    expect(normalizeCode('hf_XAU')).toBe('hf_XAU')
    expect(normalizeCode('hf_xau')).toBe('hf_XAU')
    expect(normalizeCode('hf_XAG')).toBe('hf_XAG')
  })

  it('已带前缀的字母代码必须保留大小写（hkHSI / usAAPL，不是 hkhsi / usaapl）', () => {
    expect(normalizeCode('hkHSI')).toBe('hkHSI')
    expect(normalizeCode('usAAPL')).toBe('usAAPL')
    expect(normalizeCode('AAPL')).toBe('usAAPL')         // 裸字母才补前缀
    expect(normalizeCode('usAAPL')).toBe('usAAPL')        // 不能再变成 usUSAAPL
  })

  it('解析港股：斜杠日期也能取出（原来是这里静默丢的）', () => {
    const hk = parsed.find((q) => q.code === 'hk00700')!
    expect(hk.name).toBe('腾讯控股')
    expect(hk.price).toBeGreaterThan(0)
    expect(hk.quoteDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('解析港股指数与美股', () => {
    expect(parsed.find((q) => q.code === 'hkHSI')?.name).toBe('恒生指数')
    expect(parsed.find((q) => q.code === 'usAAPL')?.name).toBe('苹果')
  })

  it('三家市场的日期格式不同但都能解析出 ISO 日期', () => {
    for (const q of parsed) expect(q.quoteDate, q.code).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

/* ══════════════════════════════════════════════════════════════
   币种折算：港股是港元、美股是美元，而账本是人民币。
   不折算会把 HK$417,480 当成 ¥417,480 加进总资产。
   ══════════════════════════════════════════════════════════════ */
describe('币种与汇率', () => {
  it('从代码前缀认币种', () => {
    expect(currencyOf('hk00100')).toBe('HKD')
    expect(currencyOf('hkHSI')).toBe('HKD')
    expect(currencyOf('usAAPL')).toBe('USD')
    expect(currencyOf('hf_XAU')).toBe('USD')
    expect(currencyOf('sh518880')).toBe('CNY')
    expect(currencyOf('sz159937')).toBe('CNY')
    expect(currencyOf('')).toBe('CNY')
  })

  it('折人民币需要的汇率代码', () => {
    expect(fxCodesFor(['HKD', 'USD', 'CNY'])).toEqual(['whHKDCNY', 'whUSDCNY'])
    expect(fxCodesFor(['CNY'])).toEqual([])   // 人民币标的不需要汇率
  })

  it('解析外汇行情：22 段的格式和股票完全不同，不能走 parseTilde', () => {
    // 真实响应：v_whHKDCNY="310~港元人民币~HKDCNY~0.8525~0~20261010045653~0.8538~..."
    const q = parseQuoteLine(
      'v_whHKDCNY="310~港元人民币~HKDCNY~0.8525~0~20261010045653~0.8538~0.8538~0.8539~0.8520~0.8545~0.8531~0.8526~0.8531~20261010045653~0.8526~0.8526~0.8526~0.8526~0.8526~0.8526~0.8526~0.8526"',
    )
    expect(q).not.toBeNull()
    expect(q!.code).toBe('whHKDCNY')
    expect(q!.price).toBe(0.8525)      // 汇率在段[3]
    expect(q!.prevClose).toBe(0.8538)  // 昨收在段[6]
    expect(q!.quoteDate).toBe('2026-10-10')
  })

  it('汇率解析失败时返回 null，而不是编一个数', () => {
    expect(parseQuoteLine('v_whHKDCNY="310~港元人民币~HKDCNY~0~0~20261010045653~0.85"')).toBeNull()
    expect(parseQuoteLine('v_whHKDCNY="310~港元人民币~HKDCNY~abc~0~20261010045653~0.85"')).toBeNull()
    expect(parseQuoteLine('v_whHKDCNY="310~short"')).toBeNull()
  })
})

/* 折算本身 */
describe('外币持仓折人民币', () => {
  const fx = new Map([['HKD', 0.85], ['USD', 6.7]])
  const holding = (code: string, quantity: number) => ({
    id: 1, accountId: 1, code, name: null, kind: 'stock',
    quantity, note: null, isActive: true, updatedAt: '2026-10-10',
  })
  const quoteOf = (code: string, price: number) => new Map([[code, {
    code, name: null, price, quoteDate: '2026-10-09', quotedAt: '2026-10-09 16:00:00', changeRate: null,
  }]])

  it('港股市值按汇率折算，不再是原币直接当人民币', () => {
    // 1960 股 × HK$213 = HK$417,480 → 按 0.85 折 ≈ ¥354,858
    const v = valueHolding(holding('hk00100', 1960), quoteOf('hk00100', 213), fx)
    expect(v.currency).toBe('HKD')
    expect(v.marketValueNative).toBe(41748000)          // 原币 HK$417,480（分）
    expect(v.marketValue).toBe(Math.round(41748000 * 0.85))  // 折人民币
    expect(v.marketValue).toBe(35485800)
    expect(v.fxRate).toBe(0.85)
  })

  it('人民币标的不折算（汇率 1）', () => {
    const v = valueHolding(holding('sh518880', 10000), quoteOf('sh518880', 8.617), fx)
    expect(v.currency).toBe('CNY')
    expect(v.fxRate).toBe(1)
    expect(v.marketValue).toBe(v.marketValueNative)
  })

  it('缺汇率时 marketValue 给 null 而不是原币值——不能把港元当人民币', () => {
    const v = valueHolding(holding('hk00100', 100), quoteOf('hk00100', 200), new Map())
    expect(v.currency).toBe('HKD')
    expect(v.fxRate).toBeNull()
    expect(v.marketValue).toBeNull()      // 关键：不能是原币当人民币
    expect(v.marketValueNative).toBe(2000000)  // 100 股 × HK$200 = HK$20,000 = 2,000,000 分
    expect(v.valued).toBe(false)          // 所以账面不会拿它冒充市值
  })

  it('美股同样折算', () => {
    const v = valueHolding(holding('usAAPL', 10), quoteOf('usAAPL', 336.64), fx)
    expect(v.currency).toBe('USD')
    expect(v.marketValue).toBe(Math.round(336640 * 6.7))
  })

  it('账户级汇总按**折算后**的值加总，不能混币种', () => {
    const hs = [holding('hk00100', 100), holding('sh518880', 100)]
    const quotes = new Map([
      ['hk00100', { code: 'hk00100', name: null, price: 200, quoteDate: '2026-10-09', quotedAt: '', changeRate: null }],
      ['sh518880', { code: 'sh518880', name: null, price: 8, quoteDate: '2026-10-09', quotedAt: '', changeRate: null }],
    ])
    const m = groupByAccount(hs, quotes, fx)
    const got = m.get(1)!
    // HK$20,000 × 0.85 = ¥17,000；¥800 不折
    expect(got.marketValue).toBe(Math.round(2000000 * 0.85) + 80000)
  })
})

/* 时间戳归一：三个市场三种格式，不统一就会被原样显示出来 */
describe('toIsoDateTime', () => {
  it('A 股紧凑格式', () => {
    expect(toIsoDateTime('20261009161450')).toBe('2026-10-09 16:14:50')
    expect(toIsoDateTime('20261009')).toBe('2026-10-09 00:00:00')
  })
  it('港股斜杠格式（之前会原样透传，页面显示成一串数字）', () => {
    expect(toIsoDateTime('2026/10/09 16:08:08')).toBe('2026-10-09 16:08:08')
  })
  it('已有 ISO 格式保持不变', () => {
    expect(toIsoDateTime('2026-10-09 16:14:56')).toBe('2026-10-09 16:14:56')
    expect(toIsoDateTime('2026-10-09T16:14:56Z')).toBe('2026-10-09 16:14:56')
  })
  it('月份/日期越界返回 null，不编时间', () => {
    expect(toIsoDateTime('20261309161450')).toBeNull()
    expect(toIsoDateTime('20261099161450')).toBeNull()
    expect(toIsoDateTime('')).toBeNull()
    expect(toIsoDateTime('乱七八糟')).toBeNull()
  })
})

describe('解析结果里的 quoteAt 已归一', () => {
  it('A 股 → ISO（用真实抓取的夹具）', () => {
    const SAMPLE = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/quotes-sample.txt'),
      'utf-8',
    )
    const q = parseQuoteResponse(SAMPLE).find((x) => x.code === 'sh518880')!
    expect(q.quoteAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(q.quoteAt.startsWith(q.quoteDate)).toBe(true)
  })
  it('港股斜杠 → ISO', () => {
    const q = parseQuoteLine(
      'v_hk00100="100~MINIMAX-W~00100~213.000~210~211~1~2~3~4~5~6~7~8~9~10~11~12~13~14~15~16~17~18~19~20~21~22~23~24~2026/10/09 16:08:08~26~27"',
    )
    expect(q?.quoteAt).toBe('2026-10-09 16:08:08')
  })
})
