/**
 * 行情解析层单元测试
 *
 * 用真实抓到的响应片段（GBK 解码后）当夹具，不联网跑。
 * 三条重点：千分位/时间戳取自实际返回、`~` 与 `,` 两种格式必须分开、
 * 快照日期必须来自行情而不是「今天」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeCode, parseQuoteResponse, parseQuoteLine, fetchQuotes } from '../../src/lib/quotes.js'

import { readFileSync } from 'node:fs'
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

  it('所有代码都返回空段 → 解析结果为 0 → fetchQuotes 抛「返回空」', async () => {
    // 写错的代码 / 退市：腾讯回 v_sh999999="";
    const body = 'v_sh999999="";\nv_sz888888="";\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => gbkBody(body),
    })))
    await expect(fetchQuotes(['999999', '888888'])).rejects.toThrow(/返回空/)
  })

  it('接口非 200 也显式抛错，不静默返回空', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      arrayBuffer: async () => new ArrayBuffer(0),
    })))
    await expect(fetchQuotes(['518880'])).rejects.toThrow(/429/)
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
