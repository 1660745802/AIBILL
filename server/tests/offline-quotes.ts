/**
 * 离线行情 provider（测试夹具，**不是**新依赖）。
 *
 * ## 为什么需要它
 *
 * 行情/汇率的上游是腾讯 `qt.gtimg.cn` 与 frankfurter.dev —— **非官方、无 SLA**。
 * 之前有三个 route 测试直接连它们：
 *   - `routes/investments.test.ts`  5 次腾讯请求，其中 1 条断言**依赖活价**，
 *     网络一断就红（文件头却写着「不联网」）；
 *   - `routes/quotes-refresh.test.ts` 4 次 ECB 请求；
 *   - `routes/quote-status.test.ts` 1 次 ECB 请求。
 * 那几次 ECB 因为错误被吞掉所以「两边都过」，代价是最坏 8s 挂钟/次——
 * 也就是说测试能不能过取决于第三方当天在不在。
 *
 * 这里把「腾讯接口」换成一份**真实抓下来的响应夹具**：
 * 认得的代码给价、不认的当没这条、全部不认时抛「返回空」，
 * 与 `lib/quotes.ts` 里真实实现的行为一一对应 —— 走的是同一条 seam，
 * 而不是把实现绕开。
 *
 * ## 用法
 *
 * ```ts
 * vi.mock('../../src/lib/quotes.js', async (orig) => {
 *   const actual = await orig<typeof import('../../src/lib/quotes.js')>()
 *   const { offlineFetchQuotes } = await import('../offline-quotes.js')   // 必须运行时 import
 *   return { ...actual, fetchQuotes: offlineFetchQuotes }
 * })
 * ```
 * `lib/fx.ts` 的主源也走 `fetchQuotes`，所以只 mock 这一处，
 * 「主源 → ECB 兜底」整条链都是真的在跑。
 *
 * ⚠️ 这里对 `src/lib/quotes.js` **只能是 `import type` + 运行时动态 import**：
 * mock 工厂被提升到文件顶部，它执行时若再静态 import 被 mock 的模块，
 * 模块图会自锁（factory 等模块、模块等 factory）。
 *
 * ## 开关
 *
 * `process.env.OFFLINE_NO_FX=1` 让这个 provider「不认外汇代码」，
 * 用来验证**主源拿不到汇率时的兜底行为**，而兜底也拿不到时不该把写入搞挂。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// type-only：编译期擦除，不在运行期产生任何依赖边
import type { Quote } from '../src/lib/quotes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const FILES = ['quotes-sample.txt', 'quotes-hk-us-sample.txt', 'quotes-fx-sample.txt']

let catalog: Map<string, Quote> | null = null

/** 夹具目录里所有真实响应合成的目录表（懒加载 + 动态 import，见文件头说明） */
async function loadCatalog(): Promise<Map<string, Quote>> {
  if (catalog) return catalog
  const { parseQuoteResponse } = await import('../src/lib/quotes.js')
  const map = new Map<string, Quote>()
  for (const file of FILES) {
    for (const q of parseQuoteResponse(readFileSync(join(FIXTURES, file), 'utf-8'))) {
      map.set(q.code, q)
    }
  }
  catalog = map
  return map
}

/** 与腾讯一致的离线 provider：认得的给价，不认的当没这条 */
export async function offlineFetchQuotes(codes: string[]): Promise<Quote[]> {
  // 与真实实现同构：**空输入直接回 []**，不发请求也不抛错
  if (codes.length === 0) return []
  const byCode = await loadCatalog()
  const hideFx = process.env.OFFLINE_NO_FX === '1'
  const out: Quote[] = []
  for (const code of codes) {
    if (hideFx && /^wh[A-Z]{6}$/.test(code)) continue      // 模拟腾讯 fx 端点挂了
    const hit = byCode.get(code)
    if (hit) out.push({ ...hit })
  }
  // 真实实现在「一条都解析不出来」时抛**带 kind 的** QuoteFetchError。
  // 这里抛同一个类型，否则测试会走一条生产里不存在的降级分类路径。
  if (out.length === 0) {
    const { QuoteFetchError } = await import('../src/lib/quotes.js')
    throw new QuoteFetchError('empty_response', '行情接口返回空（可能改格式了或被限流）')
  }
  return out
}

/** 清掉 `OFFLINE_NO_FX`，避免它跨用例残留 */
export function resetOfflineFlags(): void {
  delete process.env.OFFLINE_NO_FX
}
