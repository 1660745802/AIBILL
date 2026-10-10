/**
 * 外汇代码规范化 + 汇率获取（主源 + 兜底）。
 *
 * 背景：**汇率曾经整条链路静默失效**，界面一直显示「待补汇率」。
 * 根因不在网络也不在腾讯，而在 `normalizeCode`：
 *
 *   whHKDCNY → 小写 whhkdcny → 全是字母 → 落到「纯字母 = 美股」那条
 *            → usWHHKDCNY → 腾讯不认 → fetchQuotes 抛「返回空」
 *
 * 而汇率缺失会让**所有外币持仓都算不出人民币市值**，比股价缺失更严重。
 * 所以这里既锁住代码规范化，也锁住「主源挂了要有兜底」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeCode, fxCodesFor, currencyOf } from '../../src/lib/quotes.js'

describe('外汇代码规范化', () => {
  it('wh 开头的外汇代码不能被当成美股代码', () => {
    // 这就是那个 bug：曾经返回 usWHHKDCNY，腾讯不认，汇率永远拿不到
    expect(normalizeCode('whHKDCNY')).toBe('whHKDCNY')
    expect(normalizeCode('whUSDCNY')).toBe('whUSDCNY')
    expect(normalizeCode('whUSDHKD')).toBe('whUSDHKD')
  })

  it('全小写的 wh 代码要提升到腾讯认的大小写', () => {
    expect(normalizeCode('whhkdcny')).toBe('whHKDCNY')
    expect(normalizeCode('whusdcny')).toBe('whUSDCNY')
  })

  it('不能因为加了 wh 规则就把美股带歪', () => {
    expect(normalizeCode('AAPL')).toBe('usAAPL')
    expect(normalizeCode('usAAPL')).toBe('usAAPL')
    expect(normalizeCode('hkHSI')).toBe('hkHSI')
    expect(normalizeCode('hf_XAU')).toBe('hf_XAU')
    expect(normalizeCode('sh518880')).toBe('sh518880')
  })

  it('币种 → 汇率代码', () => {
    expect(fxCodesFor(['HKD', 'USD', 'CNY'])).toEqual(['whHKDCNY', 'whUSDCNY'])
    expect(fxCodesFor(['CNY'])).toEqual([]) // 人民币自己不需要汇率
  })
})

/* ── 汇率获取：主源 + 兜底 ──
   通过 mock 网络层来测，避免测试依赖真实第三方接口的可用性。 */
describe('汇率获取', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

  /**
   * 造一份腾讯 wh 响应。
   *
   * ⚠️ 名称用纯 ASCII。真实接口是 **GBK 字节**，而 mock 里
   * `new Response(字符串)` 会编成 UTF-8，再被解析器的 `TextDecoder('gbk')`
   * 解一遍 → 中文变乱码，而且**乱码字会把后面的 `~` 吃掉**，
   * 段数错位、价格解析成 0。用 ASCII 名称就绕开了这个测试自身的假象。
   */
  const tencentBody = (pairs: Record<string, number>) =>
    Object.entries(pairs)
      .map(([c, v]) => `v_wh${c}CNY="310~${c}~${c}CNY~${v}~0~20261010045653~${v}~${v}~${v}"`)
      .join('\n')

  it('主源腾讯可用时用腾讯，并换算出「1 外币 = 多少人民币」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tencentBody({ HKD: 0.8525 }), { status: 200 })))
    const { fetchFxRates } = await import('../../src/lib/fx.js')
    const r = await fetchFxRates(['HKD'])
    expect(r.source).toBe('tencent')
    expect(r.rates.get('HKD')).toBe(0.8525)
  })

  it('主源挂掉时落到 ECB 兜底，并把 ECB 的倒数换算正确', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('qt.gtimg.cn')) throw new Error('腾讯挂了')
      // ECB 返回的是「1 CNY = 多少外币」，要取倒数
      return new Response(JSON.stringify({ date: '2026-10-09', rates: { HKD: 1.1727 } }), { status: 200 })
    }))
    const { fetchFxRates } = await import('../../src/lib/fx.js')
    const r = await fetchFxRates(['HKD'])
    expect(r.source).toBe('ecb')
    // 1 / 1.1727 ≈ 0.85273
    expect(r.rates.get('HKD')).toBeCloseTo(0.852733, 5)
  })

  it('主源拿不到某个币种时，缺的那个用兜底补', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('qt.gtimg.cn')) return new Response(tencentBody({ HKD: 0.8525 }), { status: 200 })
      return new Response(JSON.stringify({ date: '2026-10-09', rates: { USD: 0.14943 } }), { status: 200 })
    }))
    const { fetchFxRates } = await import('../../src/lib/fx.js')
    const r = await fetchFxRates(['HKD', 'USD'])
    expect(r.rates.get('HKD')).toBe(0.8525)          // 腾讯给的
    expect(r.rates.get('USD')).toBeCloseTo(6.6921, 3) // ECB 补的（取倒数）
  })

  it('两个源都挂时返回空 Map，**不编一个数**', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('全断了') }))
    const { fetchFxRates } = await import('../../src/lib/fx.js')
    const r = await fetchFxRates(['HKD'])
    expect(r.rates.size).toBe(0)
    expect(r.source).toBe('none')
  })

  it('人民币不需要汇率，也不发请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const { fetchFxRates } = await import('../../src/lib/fx.js')
    const r = await fetchFxRates(['CNY'])
    expect(r.rates.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

/* 币种识别是折算的前提，顺带锁住 */
describe('币种识别', () => {
  it('按代码前缀认币种', () => {
    expect(currencyOf('hk00100')).toBe('HKD')
    expect(currencyOf('usAAPL')).toBe('USD')
    expect(currencyOf('hf_XAU')).toBe('USD')
    expect(currencyOf('sh518880')).toBe('CNY')
  })
})