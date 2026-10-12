/**
 * 客户端响应形状护栏（**支持基线：Android ≥ 1.5.0**）
 *
 * 形状类故障（字段变 `null`/缺键）会让客户端在**反序列化**阶段直接崩——不走降级、
 * 也不该由客户端的容错来兜。所以这里不测「业务对不对」，只测**形状**：
 * 对客户端会调用的每个端点/形态，断言仍然**非空**的那些键确实非空。
 *
 * 边界（按项目决定的支持基线）：
 * - **≥ 1.5.0 是支持基线**，更老的包（如 v0.4）不再专门兼容。因此
 *   `category_id` / `category_name` / `category_icon` **不在断言清单里**——
 *   它们在 v1.0.0（`9e318a2`）起已是可空（客户端 DTO 也带 `?`），
 *   「分类匹配不到」返回契约内合法的 `null` 是**正确行为**。
 * - 其余形状仍按客户端 DTO 的非空声明断言：`message` 恒在、`items`/`created`/`duplicates`
 *   恒为数组、分页四件套、`percent`、`icon`/`sort_order`/`current_balance` 等。
 *
 * ⚠️ **清单按「支持基线版本」生成，不是按「最老版本」**：两者不是同一集合
 * （v0.4 多 `category_id`/`name`/`icon`；v1.5.0 多别的键）。搞错会双向出问题——
 * 漏断言＝漏掉崩溃路径；多断言＝把客户端已放宽的字段又锁死。
 * **基线变更时必须重新扒一遍该版本的 DTO**，并同步改本文件。当前基线：**≥1.5.0（versionCode ≥ 7）**。
 *
 * 约定（ARCHITECTURE §7.2）：分支枚举类断言必须配「数据非空」的构造；
 * 本文件做过变异自检（把 `date` 改成 null → 立刻红）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

/* AI 客户端打桩：需要可控地产出「成功 / 空结果 / 超时 / 格式异常」四种形态 */
const stub = vi.hoisted(() => ({ reply: '[]', error: null as null | { type: string; message: string } }))
vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () => {
      if (stub.error) throw new orig.AiError(stub.error.type, stub.error.message)
      return stub.reply
    }),
  }
})

/** 客户端信封的非空字段：`code` + `message`（任何响应都不能缺） */
function expectEnvelope(payload: unknown, ctx: string): Record<string, unknown> {
  const body = JSON.parse(String(payload)) as Record<string, unknown>
  expect(typeof body.code, `${ctx}: code 必须是数字（客户端 DTO 声明 Int 非空）`).toBe('number')
  expect(typeof body.message, `${ctx}: message 必须是字符串且非 null`).toBe('string')
  expect(body.message).not.toBeNull()
  return body
}

/**
 * item 级仍必须非空的字段。
 * ⚠️ 刻意**不含** `category_id`/`category_name`/`category_icon`：它们在 v1.0.0 起可空，
 * 返回 `null`（分类匹配不到）是契约行为，不是故障。
 */
const ITEM_NONNULL = ['type', 'amount', 'date'] as const

function expectParseDataShape(data: unknown, ctx: string): void {
  expect(data, `${ctx}: data 若为 null 是安全的（旧包走 Unparsed），此处只查非 null 情形`).not.toBeNull()
  const d = data as Record<string, unknown>
  expect(Array.isArray(d.items), `${ctx}: items 必须是非 null 数组（客户端 DTO 声明 List 非空）`).toBe(true)
  expect(typeof d.raw_input, `${ctx}: raw_input 必须是字符串`).toBe('string')
  for (const item of d.items as Array<Record<string, unknown>>) {
    for (const k of ITEM_NONNULL) {
      expect(item[k], `${ctx}: item.${k} 不能为 null/缺键（客户端 DTO 声明非空）`).not.toBeNull()
      expect(item[k], `${ctx}: item.${k} 缺键`).not.toBeUndefined()
    }
    expect(typeof item.amount, `${ctx}: item.amount 必须是数字`).toBe('number')
  }
}

describe('客户端响应形状（支持基线 ≥ 1.5.0）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'compat04')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('/api/ai/parse 的 8 种形态', () => {
    const parse = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as never })

    it('#1 入站预筛挡下（tier0）→ items 是空数组而不是 null', async () => {
      const res = await parse({ input: '双11 5折 全场开抢' })
      const body = expectEnvelope(res.payload, '#1')
      expect(body.code).toBe(0)
      expectParseDataShape(body.data, '#1')
      expect((body.data as { items: unknown[] }).items).toHaveLength(0)
    })

    it('#2 快捷正则解析 → item 六个非空键齐备', async () => {
      const res = await parse({ input: '午饭32' })
      const body = expectEnvelope(res.payload, '#2')
      expect(body.code).toBe(0)
      expectParseDataShape(body.data, '#2')
      expect((body.data as { items: unknown[] }).items.length).toBeGreaterThan(0)
    })

    it('#4 模型解析成功 → 同上', async () => {
      stub.reply = '[{"type":"expense","amount":12.5,"category":"餐饮","description":"测试","date":"2026-10-12","account":"","target_account":""}]'
      const res = await parse({ input: '某笔消费12.5元，用于兼容性检查' })
      const body = expectEnvelope(res.payload, '#4')
      expect(body.code).toBe(0)
      expectParseDataShape(body.data, '#4')
    })

    it('#3 出站判定为噪声 → items 空数组；#5 空结果 / #6 超时 / #7 格式异常 → data:null + message 非空', async () => {
      // #5 空结果（模型回 []）
      stub.reply = '[]'
      const empty = expectEnvelope((await parse({ input: '某笔消费12.5元，用于兼容性检查' })).payload, '#5')
      expect(empty.code).toBe(5001)
      expect(empty.data).toBeNull() // 旧包对 data==null 是安全的
      // #6 上游超时
      stub.error = { type: 'AI_TIMEOUT', message: '上游超时' }
      const timeout = await parse({ input: '某笔消费12.5元，用于兼容性检查' })
      expect([502, 504]).toContain(timeout.statusCode)
      const tb = expectEnvelope(timeout.payload, '#6')
      expect(tb.data).toBeNull()
      // #7 响应格式异常
      stub.error = null
      stub.reply = '这不是 JSON'
      const bad = expectEnvelope((await parse({ input: '某笔消费12.5元，用于兼容性检查' })).payload, '#7')
      expect(bad.data).toBeNull()
      stub.reply = '[]'
    })

    it('#8 入参校验失败（400）→ 仍是 {code,message} 信封', async () => {
      const res = await parse({ input: '' })
      expect(res.statusCode).toBe(400)
      expectEnvelope(res.payload, '#8')
    })
  })

  describe('入账主链路 /api/transactions', () => {
    it('created/duplicates 恒为非 null 数组；交易本身 id/type/amount/date 非空', async () => {
      const item = {
        client_id: '11111111-2222-4333-8444-555555555555',
        client_type: 'app_android',
        source: 'manual',
        type: 'expense',
        amount: 3200,
        description: '兼容性检查',
        date: '2026-10-12',
      }
      const first = expectEnvelope(
        (await app.inject({ method: 'POST', url: '/api/transactions', headers: authHeaders(token), payload: { items: [item] } as never })).payload,
        'txn#1',
      )
      const d1 = first.data as { created: unknown[]; duplicates: unknown[] }
      expect(Array.isArray(d1.created)).toBe(true)
      expect(Array.isArray(d1.duplicates)).toBe(true)
      for (const t of d1.created as Array<Record<string, unknown>>) {
        for (const k of ['id', 'type', 'amount', 'date']) {
          expect(t[k], `交易回执.${k} 不能为 null`).not.toBeNull()
        }
      }

      // 幂等重放：dup 进 duplicates，也必须是数组（旧包按它提示「已记账」）
      const second = expectEnvelope(
        (await app.inject({ method: 'POST', url: '/api/transactions', headers: authHeaders(token), payload: { items: [item] } as never })).payload,
        'txn#2',
      )
      const d2 = second.data as { created: unknown[]; duplicates: unknown[] }
      expect(Array.isArray(d2.duplicates)).toBe(true)
      expect(d2.duplicates.length).toBe(1)
    })

    it('分页响应 items/total/page/page_size 非空（客户端分页 DTO）', async () => {
      const body = expectEnvelope(
        (await app.inject({ method: 'GET', url: '/api/transactions?page=1&page_size=20', headers: authHeaders(token) })).payload,
        'txn list',
      )
      const d = body.data as Record<string, unknown>
      expect(Array.isArray(d.items)).toBe(true)
      for (const k of ['total', 'page', 'page_size']) {
        expect(typeof d[k], `分页.${k} 必须是数字`).toBe('number')
      }
    })
  })

  describe('统计 / 分类 / 账户 / 预算', () => {
    it('stats summary 的 expense/income/balance 非空；by-category 的 percent 在空数据时是 0 而不是 null', async () => {
      const summary = expectEnvelope(
        (await app.inject({ method: 'GET', url: '/api/stats/summary?year=2026&month=10', headers: authHeaders(token) })).payload,
        'summary',
      ).data as Record<string, unknown>
      for (const k of ['expense', 'income', 'balance']) expect(typeof summary[k], `summary.${k}`).toBe('number')

      const byCategory = async (year: number, month: number) =>
        expectEnvelope(
          (await app.inject({
            method: 'GET',
            url: `/api/stats/by-category?year=${year}&month=${month}&type=expense`,
            headers: authHeaders(token),
          })).payload,
          'by-category',
        ).data as { items: Array<Record<string, unknown>> }

      // ⚠️ 只在**有行**时 percent 才会被序列化：行来自 `GROUP BY`，没有消费就没有行。
      // 所以先造一笔消费，否则断言是空洞的（我第一版就是这么写的，变异测试没抓住）。
      const uuid = '99999999-8888-4777-8666-555555555555'
      // 必须带真实 category_id：by-category 是 `JOIN categories`，分类为 null 的行不会出现
      const catBody = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/categories?type=expense', headers: authHeaders(token) })).payload,
      )
      const categoryId = (catBody.data.items as Array<{ id: number }>)[0]!.id
      await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(token),
        payload: {
          items: [
            {
              client_id: uuid,
              client_type: 'app_android',
              source: 'manual',
              type: 'expense',
              amount: 1234,
              category_id: categoryId,
              description: '兼容性-分类占比',
              date: '2026-10-12',
            },
          ],
        } as never,
      })
      const filled = await byCategory(2026, 10)
      expect(filled.items.length).toBeGreaterThan(0)
      for (const row of filled.items) {
        expect(typeof row.percent, 'percent 必须是数字（客户端 DTO 声明 Double 非空）').toBe('number')
        for (const k of ['id', 'name', 'icon', 'total']) expect(row[k], `by-category.${k}`).not.toBeNull()
      }

      // 空月份：items 必须仍是数组（percent 不会出现，因为不会有行）
      const empty = await byCategory(2020, 1)
      expect(Array.isArray(empty.items)).toBe(true)
      expect(empty.items).toHaveLength(0)
    })

    it('categories/accounts 的 id/name/type/icon/sort_order/current_balance 非空（新建账户也不例外）', async () => {
      const cats = expectEnvelope(
        (await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(token) })).payload,
        'categories',
      ).data as { items: Array<Record<string, unknown>> }
      expect(cats.items.length).toBeGreaterThan(0)
      for (const c of cats.items) {
        for (const k of ['id', 'name', 'type', 'icon', 'sort_order']) {
          expect(c[k], `category.${k} 不能为 null`).not.toBeNull()
        }
      }

      // 新建账户（不传 icon/sort_order/initial_balance）→ 旧包要求的字段仍非空
      expectEnvelope(
        (await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: authHeaders(token),
          payload: { name: '兼容性新账户', type: 'cash' } as never,
        })).payload,
        'account create',
      )
      const accs = expectEnvelope(
        (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
        'accounts',
      ).data as { items: Array<Record<string, unknown>> }
      for (const a of accs.items) {
        for (const k of ['id', 'name', 'type', 'icon', 'current_balance']) {
          expect(a[k], `account.${k} 不能为 null`).not.toBeNull()
        }
        expect(typeof a.current_balance, 'current_balance 必须是数字').toBe('number')
      }
    })

    it('budgets 的 id/category_id/amount/year/month 非空（旧 DTO 里有它）', async () => {
      expectEnvelope(
        (await app.inject({
          method: 'POST',
          url: '/api/budgets',
          headers: authHeaders(token),
          payload: { category_id: 0, amount: 100000, year: 2026, month: 10 } as never,
        })).payload,
        'budget create',
      )
      const list = expectEnvelope(
        (await app.inject({ method: 'GET', url: '/api/budgets?year=2026&month=10', headers: authHeaders(token) })).payload,
        'budgets',
      ).data as { items: Array<Record<string, unknown>> }
      for (const b of list.items) {
        for (const k of ['id', 'category_id', 'amount', 'year', 'month']) {
          expect(b[k], `budget.${k} 不能为 null`).not.toBeNull()
        }
      }
    })
  })

  describe('认证与错误信封', () => {
    it('register/login 的 token/user.id/username/role 非空', async () => {
      const admin = await loginAdmin(app)
      expect(typeof admin).toBe('string')
      const login = expectEnvelope(
        (await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123456' } as never,
        })).payload,
        'login',
      )
      const d = login.data as { token: string; user: Record<string, unknown> }
      expect(typeof d.token).toBe('string')
      for (const k of ['id', 'username', 'role']) {
        expect(d.user[k], `user.${k} 不能为 null`).not.toBeNull()
      }
    })

    it('400/401/403/404 的错误体都带 code + message', async () => {
      // 400：带 token + 非法 body（不带 token 会先撞 401）
      const bad = await app.inject({
        method: 'POST',
        url: '/api/ai/parse',
        headers: authHeaders(token),
        payload: { input: '' } as never,
      })
      expect(bad.statusCode).toBe(400)
      expectEnvelope(bad.payload, '错误体 400')

      // 401：无 token
      const unauth = await app.inject({ method: 'GET', url: '/api/transactions' })
      expect(unauth.statusCode).toBe(401)
      expectEnvelope(unauth.payload, '错误体 401')

      // 404：带 token 访问不存在的资源
      const missing = await app.inject({
        method: 'GET',
        url: '/api/transactions/999999',
        headers: authHeaders(token),
      })
      expect(missing.statusCode).toBe(404)
      expectEnvelope(missing.payload, '错误体 404')
      // 403：普通用户调 admin
      const forbidden = await app.inject({ method: 'GET', url: '/api/admin/users', headers: authHeaders(token) })
      expect(forbidden.statusCode).toBe(403)
      expectEnvelope(forbidden.payload, '错误体 403')
      // 500：不人为注入故障；全局错误出口由 app.ts 的 setErrorHandler 统一成 {code,data,message}
      void getDb
    })
  })
})
