/**
 * `POST /api/ai/parse` 入参上下文扩展（契约 docs/recognition-flow.md §5）
 *
 * 本轮客户端多送 `channel` / `source` / `title` / `body` / `received_at` / `hints`。
 * 这里锁住四件事：
 *   1. 校验边界：`input` 仍唯一必填、`channel` 枚举、`received_at` **必须带时区偏移**、
 *      未知键**不** 400（zod 静默剥离，向后兼容靠这个）；
 *   2. 「锚定日期」= received_at 的**北京日期**，且超窗口时回落 `today()`（手机时钟歪的护栏）；
 *   3. 入参上下文真的落进 `ai_parse_logs` / `ai_parse_filters`（migration 019 的新列）；
 *   4. `hints_conflict` 是**机械比对**（不喂 prompt）：hints 金额与文本金额不一致才 true。
 *
 * 所有模型调用打桩；`tests/setup.ts` 还有外发守卫，本文件必须离线。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { today, addDaysTo } from '../../src/lib/date.js'

// 模型打桩：固定返回一笔 68 元的支出（文本里也带着 68.00 元），
// 这样「hints_conflict 是否只做机械比对」是可判定的——模型输出与 hint 无关。
vi.mock('../../src/ai/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/client.js')>()
  return {
    ...orig,
    chatCompletion: vi.fn(async () =>
      JSON.stringify([
        { type: 'expense', amount: 68, category: '餐饮', description: '星巴克', date: '', account: '', target_account: '' },
      ]),
    ),
  }
})

interface ParseLogRow {
  channel: string | null
  source_package: string | null
  received_at: string | null
  hints: string | null
}

describe('ai/parse 入参上下文扩展', () => {
  let app: FastifyInstance
  let token: string
  let userId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'parsectx')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    userId = JSON.parse(me.payload).data.user.id
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/ai/parse', headers: authHeaders(token), payload: payload as any })

  const logOf = (id: number): ParseLogRow =>
    getDb()
      .prepare('SELECT channel, source_package, received_at, hints FROM ai_parse_logs WHERE id = ?')
      .get(id) as ParseLogRow

  describe('入参校验', () => {
    it('非法 channel → 400（枚举外）', async () => {
      const res = await post({ input: '午饭32', channel: 'telepathy' })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).code).toBe(2000)
    })

    it('未知键被静默剥离，不 400（向后兼容：服务端加字段前客户端不可依赖）', async () => {
      const res = await post({ input: '午饭32', something_from_the_future: { x: 1 }, client_version: '9.9.9' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.source).toBe('quick')
    })

    it('received_at 缺时区偏移 → 400', async () => {
      const res = await post({ input: '午饭32', received_at: '2026-10-12T23:40:00' })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).code).toBe(2000)
    })

    it('received_at 带偏移但不可解析 → 400', async () => {
      const res = await post({ input: '午饭32', received_at: 'not-a-date+08:00' })
      expect(res.statusCode).toBe(400)
    })

    it('channel 合法 + 其它新键全给：正常解析', async () => {
      const res = await post({
        input: '午饭32',
        channel: 'manual',
        source: { package_name: 'com.example.app', source_name: '示例' },
        title: '手动记账',
        body: '正文',
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).code).toBe(0)
    })
  })

  describe('锚定日期', () => {
    it('received_at = 昨天 23:40(+08:00) 时，quick 路径 item.date = 昨天', async () => {
      const yesterday = addDaysTo(today(), -1)
      const res = await post({ input: '午饭32', received_at: `${yesterday}T23:40:00+08:00` })
      const body = JSON.parse(res.payload)
      expect(body.data.source).toBe('quick')
      expect(body.data.items[0].date).toBe(yesterday)
    })

    it('received_at 超窗口（30 天前）→ 忽略并回落今天', async () => {
      const far = addDaysTo(today(), -30)
      const res = await post({ input: '午饭32', received_at: `${far}T10:00:00+08:00` })
      const body = JSON.parse(res.payload)
      expect(body.data.items[0].date).toBe(today())
    })

    it('AI 路径同样用锚定日期（模型 date 为空时落到 received_at 的北京日期）', async () => {
      const yesterday = addDaysTo(today(), -1)
      const res = await post({
        input: '星巴克两杯拿铁 信用卡支付 68.00元',
        received_at: `${yesterday}T22:00:00+08:00`,
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items[0].date).toBe(yesterday)
    })
  })

  describe('落库（migration 019 新列）', () => {
    it('channel / source.package_name / received_at / hints 落进 ai_parse_logs', async () => {
      const receivedAt = `${today()}T10:00:00+08:00`
      const hints = { amount_cents: 3200, merchant: '美团', direction: 'expense' }
      const res = await post({
        input: '午饭32元',
        channel: 'nls',
        source: { package_name: 'com.tencent.mm', source_name: '微信支付' },
        received_at: receivedAt,
        hints,
      })
      const body = JSON.parse(res.payload)
      const logId = body.data.parse_log_id
      expect(typeof logId).toBe('number')

      const row = logOf(logId)
      expect(row.channel).toBe('nls')
      expect(row.source_package).toBe('com.tencent.mm')
      expect(row.received_at).toBe(receivedAt)
      // hints 以 JSON 字符串存（与 parsed_items 同风格）；source_name 只作参考、不落库
      expect(JSON.parse(row.hints!)).toEqual(hints)
    })

    it('预筛路径（inbound）把 channel / source_package 落进 ai_parse_filters', async () => {
      const res = await post({
        input: '😍1号会员日来啦 🛒12包抽纸0元领千份放量！ 🔥实付159元再享40元红包返利>',
        channel: 'sms',
        source: { package_name: 'com.android.mms' },
      })
      expect(JSON.parse(res.payload).data.source).toBe('prefilter')

      const row = getDb()
        .prepare(
          'SELECT channel, source_package FROM ai_parse_filters WHERE user_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(userId) as { channel: string | null; source_package: string | null }
      expect(row.channel).toBe('sms')
      expect(row.source_package).toBe('com.android.mms')
    })

    it('不带新键的旧 payload：新列为 NULL，不猜值', async () => {
      const res = await post({ input: '午饭32' })
      const logId = JSON.parse(res.payload).data.parse_log_id
      const row = logOf(logId)
      expect(row.channel).toBeNull()
      expect(row.source_package).toBeNull()
      expect(row.received_at).toBeNull()
      expect(row.hints).toBeNull()
    })
  })

  describe('hints_conflict（机械比对，不喂 prompt）', () => {
    it('hints 金额与文本一致 → false', async () => {
      const res = await post({ input: '午饭32元', hints: { amount_cents: 3200 } })
      expect(JSON.parse(res.payload).data.hints_conflict).toBe(false)
    })

    it('hints 金额与文本不一致 → true（quick 成功形态）', async () => {
      const res = await post({ input: '午饭32元', hints: { amount_cents: 9900 } })
      expect(JSON.parse(res.payload).data.hints_conflict).toBe(true)
    })

    it('无 hints 或无金额信号 → false', async () => {
      // 无 hints
      expect(JSON.parse((await post({ input: '午饭32元' })).payload).data.hints_conflict).toBe(false)
      // 有 hints 但文本里抽不出带单位金额 → 不把「缺依据」当冲突
      expect(JSON.parse((await post({ input: '午饭32', hints: { amount_cents: 3200 } })).payload).data.hints_conflict).toBe(false)
    })

    it('AI 成功形态（#4）同样返回 hints_conflict', async () => {
      const base = '星巴克两杯拿铁 信用卡支付 68.00元'
      const match = JSON.parse((await post({ input: base, hints: { amount_cents: 6800 } })).payload)
      expect(match.code).toBe(0)
      expect(match.data.hints_conflict).toBe(false)

      const mismatch = JSON.parse((await post({ input: base, hints: { amount_cents: 100 } })).payload)
      expect(mismatch.data.hints_conflict).toBe(true)
    })
  })
})
