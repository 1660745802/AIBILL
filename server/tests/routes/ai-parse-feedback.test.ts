/**
 * parse-feedback 自动学习（`ai_memories` 写入）回归
 *
 * 契约（docs/API.md 附录 C §2）：`final_items` 是**用户确认后的最终态**——
 * 删除 = 该项不在数组里，新增 = 数组里多出的项。所以两侧条数/顺序本来就会变。
 *
 * 旧实现按 index 配对 `original[i]`/`final[i]` 并 `Math.min` 截断。记忆内容取自 final，
 * 所以错的不是「描述↔分类」配错，而是**「这一项到底被改了没有」判错**：
 * 位置一变就把没改的项当成改了（学出多余记忆）。而 ai_memories 会被注入 prompt，
 * 错一次就一直错。本文件锁住「按 description 配对、有歧义/新增就不学」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('parse-feedback 自动学习', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  /** 每个用例用独立用户，断言就不用忍受历史记忆累积 */
  async function newUser(name: string): Promise<{ token: string; userId: number }> {
    const token = await createUser(app, name)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })
    return { token, userId: JSON.parse(me.payload).data.user.id }
  }

  function seedParseLog(userId: number, parsedItems: unknown[]): number {
    const res = getDb()
      .prepare(
        `INSERT INTO ai_parse_logs (user_id, raw_input, ai_response, parsed_items, status, duration_ms)
         VALUES (?, ?, ?, ?, 'success', 1)`,
      )
      .run(userId, 'seed-input', '[seed]', JSON.stringify(parsedItems))
    return Number(res.lastInsertRowid)
  }

  function feedMemories(userId: number): string[] {
    const rows = getDb()
      .prepare('SELECT content FROM ai_memories WHERE user_id = ? ORDER BY id')
      .all(userId) as Array<{ content: string }>
    return rows.map((r) => r.content)
  }

  async function feedback(token: string, logId: number, finalItems: unknown[], modified = true) {
    return app.inject({
      method: 'POST',
      url: '/api/ai/parse-feedback',
      headers: authHeaders(token),
      payload: { parse_log_id: logId, final_items: finalItems, modified },
    })
  }

  it('删掉首条后仍只学真实改动（不产生未改项的记忆）', async () => {
    const { token, userId } = await newUser('fbdelete')
    const logId = seedParseLog(userId, [
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
      { description: '打车', category_name: '交通', account_name: '微信' },
    ])

    // 用户删掉「午饭」，只留「打车」并把分类改成「出行」
    const res = await feedback(token, logId, [
      { description: '打车', category_name: '出行', account_name: '微信' },
    ])

    expect(res.statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual(['"打车"应该归类为"出行"'])
    // 「午饭」根本没被改，绝不该产生任何记忆
    expect(feedMemories(userId).some((m) => m.includes('午饭'))).toBe(false)
  })

  it('顺序变化不影响配对（按 description 而不是位置）', async () => {
    const { token, userId } = await newUser('fbreorder')
    const logId = seedParseLog(userId, [
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
      { description: '打车', category_name: '交通', account_name: '微信' },
    ])

    // 顺序颠倒 + 只改「打车」的分类
    const res = await feedback(token, logId, [
      { description: '打车', category_name: '出行', account_name: '微信' },
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
    ])

    expect(res.statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual(['"打车"应该归类为"出行"'])
  })

  it('新增项（原始里没有该描述）不学习', async () => {
    const { token, userId } = await newUser('fbadd')
    const logId = seedParseLog(userId, [{ description: '午饭', category_name: '餐饮', account_name: '微信' }])

    const res = await feedback(token, logId, [
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
      { description: '加了一杯咖啡', category_name: '餐饮', account_name: '支付宝' },
    ])

    expect(res.statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual([])
  })

  it('描述重复（歧义）时整组都不学，不猜', async () => {
    const { token, userId } = await newUser('fbambiguous')
    const logId = seedParseLog(userId, [
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
      { description: '午饭', category_name: '餐饮', account_name: '支付宝' },
    ])

    const res = await feedback(token, logId, [
      { description: '午饭', category_name: '出行', account_name: '微信' },
      { description: '午饭', category_name: '出行', account_name: '支付宝' },
    ])

    expect(res.statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual([])
  })

  it('分类与账户同时被改 → 两条记忆；重复反馈不重复写入', async () => {
    const { token, userId } = await newUser('fbboth')
    const logId = seedParseLog(userId, [{ description: '午饭', category_name: '餐饮', account_name: '微信' }])
    const final = [{ description: '午饭', category_name: '出行', account_name: '支付宝' }]

    expect((await feedback(token, logId, final)).statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual([
      '"午饭"应该归类为"出行"',
      '"午饭"一般用"支付宝"支付',
    ])

    // 幂等：同一修正再回传一次，不产生重复记忆
    expect((await feedback(token, logId, final)).statusCode).toBe(200)
    expect(feedMemories(userId)).toHaveLength(2)
  })

  it('modified=false 不写入任何记忆（但记录反馈本身）', async () => {
    const { token, userId } = await newUser('fbunmodified')
    const logId = seedParseLog(userId, [{ description: '午饭', category_name: '餐饮', account_name: '微信' }])

    const res = await feedback(token, logId, [{ description: '午饭', category_name: '出行', account_name: '微信' }], false)

    expect(res.statusCode).toBe(200)
    expect(feedMemories(userId)).toEqual([])
  })

  it('越权：别人的 parse_log_id → 404，且不写任何记忆', async () => {
    const owner = await newUser('fbowner')
    const other = await newUser('fbother')
    const logId = seedParseLog(owner.userId, [
      { description: '午饭', category_name: '餐饮', account_name: '微信' },
    ])

    const res = await feedback(other.token, logId, [
      { description: '午饭', category_name: '出行', account_name: '微信' },
    ])

    expect(res.statusCode).toBe(404)
    expect(feedMemories(owner.userId)).toEqual([])
    expect(feedMemories(other.userId)).toEqual([])
  })
})
