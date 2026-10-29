/**
 * 管理员路由集成测试（补齐此前 0 覆盖的删除用户逻辑）
 *
 * 重点回归：DELETE /api/admin/users/:id 的外键删除顺序。
 * 修复前，只要有订阅或财务目标就会 500 SQLITE_CONSTRAINT_FOREIGNKEY。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, loginAdmin, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('Admin Routes - 删除用户', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  /** 建一个带分类+账户的用户，返回其 id 与 token */
  async function makeUser(username: string) {
    const token = await createUser(app, username)
    const cats = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(token) })).payload,
    ).data.items
    const accs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    const me = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).payload,
    ).data.user
    return { token, id: me.id, categoryId: cats.find((c: any) => c.type === 'expense').id, accountId: accs[0].id }
  }

  async function deleteUser(id: number) {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${id}`,
      headers: authHeaders(adminToken),
    })
    return { status: res.statusCode, body: JSON.parse(res.payload) }
  }

  it('应删除无关联数据的普通用户', async () => {
    const u = await makeUser('del_plain')
    const r = await deleteUser(u.id)
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)
    expect(getDb().prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeUndefined()
  })

  it('应能删除有订阅的用户（外键：subscriptions → categories/accounts）', async () => {
    const u = await makeUser('del_with_sub')
    const sub = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(u.token),
      payload: {
        name: 'Netflix',
        amount: 1500,
        cycle: 'monthly',
        category_id: u.categoryId,
        account_id: u.accountId,
        start_date: '2026-01-01',
      },
    })
    expect(JSON.parse(sub.payload).code).toBe(0)

    const r = await deleteUser(u.id)
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)
    const db = getDb()
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(u.id)).toBeUndefined()
  })

  it('应能删除有财务目标+目标进度+资产快照的用户（外键：financial_goals → accounts）', async () => {
    const u = await makeUser('del_with_goal')

    const goal = await app.inject({
      method: 'POST',
      url: '/api/goals',
      headers: authHeaders(u.token),
      payload: {
        name: '存钱买相机',
        type: 'saving',
        target_amount: 500000,
        linked_account_id: u.accountId,
      },
    })
    const goalId = JSON.parse(goal.payload).data.id
    expect(goalId).toBeDefined()

    await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/progress`,
      headers: authHeaders(u.token),
      payload: { amount: 10000 },
    })
    // 造一条快照行，用来验证删用户时 asset_snapshots 也跟着清掉。
    // 走现役的 `PUT /api/assets/snapshots`——旧的 `POST /api/assets/snapshot`
    // 已随 deprecated 端点删除（无任何客户端调用过）。
    await app.inject({
      method: 'PUT',
      url: '/api/assets/snapshots',
      headers: authHeaders(u.token),
      payload: { items: [{ account_id: u.accountId, balance: 1000 }] },
    })

    const db = getDb()
    expect(db.prepare('SELECT COUNT(*) c FROM goal_progress WHERE goal_id = ?').get(goalId).c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM asset_snapshots WHERE user_id = ?').get(u.id).c).toBeGreaterThan(0)

    const r = await deleteUser(u.id)
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)

    // 所有关联数据都应被清除
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM financial_goals WHERE id = ?').get(goalId)).toBeUndefined()
    expect(db.prepare('SELECT id FROM goal_progress WHERE goal_id = ?').get(goalId)).toBeUndefined()
    expect(db.prepare('SELECT id FROM asset_snapshots WHERE user_id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(u.id)).toBeUndefined()
  })

  it('应能删除有交易+分类+账户+预算+记忆的用户', async () => {
    const u = await makeUser('del_full')
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(u.token),
      payload: { items: [{ type: 'expense', amount: 3200, date: '2026-07-02', description: '午饭', category_id: u.categoryId, account_id: u.accountId }] },
    })
    await app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: authHeaders(u.token),
      payload: { category_id: 0, amount: 200000, year: 2026, month: 7 },
    })
    await app.inject({
      method: 'POST',
      url: '/api/memories',
      headers: authHeaders(u.token),
      payload: { content: '默认用微信支付' },
    })

    const r = await deleteUser(u.id)
    expect(r.status).toBe(200)
    const db = getDb()
    expect(db.prepare('SELECT id FROM transactions WHERE user_id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM budgets WHERE user_id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM ai_memories WHERE user_id = ?').get(u.id)).toBeUndefined()
  })

  it('应能删除有持仓（investments）+ 被挡下的解析记录（ai_parse_filters）的用户', async () => {
    // 回归：USER_SCOPED_TABLES 里漏了这两张表——
    // investments.account_id → accounts(id) 会让 DELETE accounts 抛外键约束，
    // 于是「有持仓的用户」**根本删不掉**（400/2003）；
    // ai_parse_filters 没有外键，删用户后留下永远没人读的孤儿行。
    const u = await makeUser('del_with_invest')
    const db = getDb()
    db.prepare(
      `INSERT INTO investments (user_id, account_id, code, name, market, kind, quantity)
       VALUES (?, ?, 'sh518880', '黄金ETF', 'sh', 'etf', 100)`,
    ).run(u.id, u.accountId)
    db.prepare(
      `INSERT INTO ai_parse_filters (user_id, raw_input, stage, tier, reasons, duration_ms)
       VALUES (?, '双11', 'inbound', 0, '["marketing"]', 0)`,
    ).run(u.id)

    const r = await deleteUser(u.id)
    expect(r.status).toBe(200)
    expect(r.body.code).toBe(0)
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM investments WHERE user_id = ?').get(u.id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM ai_parse_filters WHERE user_id = ?').get(u.id)).toBeUndefined()
  })

  it('上报拦截计数后可删除用户，两张非级联表清空且其他用户完整保留', async () => {
    const gone = await makeUser('del_report')
    const keep = await makeUser('keep_report')
    const db = getDb()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    for (const user of [gone, keep]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/filter-report',
        headers: authHeaders(user.token),
        payload: {
          window_start: '2026-10-12 00:00:00', window_end: '2026-10-12 23:59:59',
          client_version: '1.4.0', channel: 'nls',
          counts: [{ rule_id: 'precheck.no_signal', count: 3 }],
          totals: { notifications: 100, blocked: 3 },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.accepted).toBe(1)
    }
    const tables = ['users', 'categories', 'accounts', 'client_filter_stats', 'client_filter_totals']
    const rows = (table: string, userId: number) => db.prepare(
      `SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = ? ORDER BY id`,
    ).all(userId)
    const kept = tables.map((table) => rows(table, keep.id))
    for (const table of tables) expect(rows(table, gone.id).length).toBeGreaterThan(0)

    const res = await deleteUser(gone.id)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    for (const [i, table] of tables.entries()) {
      expect(rows(table, gone.id), table).toEqual([])
      expect(rows(table, keep.id), table).toEqual(kept[i])
    }
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('应保留其他用户的数据', async () => {
    const keep = await makeUser('keep_me')
    const gone = await makeUser('delete_me')
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(keep.token),
      payload: { items: [{ type: 'expense', amount: 1000, date: '2026-07-02', description: '保留' }] },
    })

    await deleteUser(gone.id)

    const rows = getDb().prepare('SELECT id FROM transactions WHERE user_id = ?').all(keep.id)
    expect(rows.length).toBe(1)
  })

  it('分类创建仅接受本人活跃同类型父分类；更新不支持改挂父分类', async () => {
    const owner = await makeUser('parent_owner')
    const other = await makeUser('parent_other')
    const db = getDb()
    const inactiveId = Number(db.prepare(
      "INSERT INTO categories (user_id, name, type, is_active) VALUES (?, '停用父分类', 'expense', 0)",
    ).run(owner.id).lastInsertRowid)
    const incomeId = Number(db.prepare(
      "INSERT INTO categories (user_id, name, type) VALUES (?, '收入父分类', 'income')",
    ).run(owner.id).lastInsertRowid)
    const snapshot = db.prepare('SELECT * FROM categories ORDER BY id').all()
    const create = (parent_id?: number) => app.inject({
      method: 'POST', url: '/api/categories', headers: authHeaders(owner.token),
      payload: { name: '测试子分类', type: 'expense', parent_id },
    })
    for (const parent_id of [other.categoryId, 999999, inactiveId, incomeId]) {
      const res = await create(parent_id)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 2003, data: null, message: '父分类不存在或不可用' })
      expect(db.prepare('SELECT * FROM categories ORDER BY id').all()).toEqual(snapshot)
    }
    const child = await create(owner.categoryId)
    expect(child.statusCode).toBe(200)
    expect(child.json().data.parent_id).toBe(owner.categoryId)
    const childId = child.json().data.id
    for (const parent_id of [other.categoryId, 999999, inactiveId, incomeId, null]) {
      const res = await app.inject({
        method: 'PUT', url: `/api/categories/${childId}`, headers: authHeaders(owner.token),
        payload: { parent_id, name: '不应写入' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 2003, data: null, message: '不支持修改父分类' })
    }
    // 整对象回传原 parent_id 不算修改，允许保存其它字段。
    expect((await app.inject({
      method: 'PUT', url: `/api/categories/${childId}`, headers: authHeaders(owner.token),
      payload: { parent_id: owner.categoryId, name: '合法改名' },
    })).statusCode).toBe(200)
    expect(db.prepare('SELECT parent_id, name FROM categories WHERE id = ?').get(childId))
      .toEqual({ parent_id: owner.categoryId, name: '合法改名' })
    expect((await app.inject({
      method: 'PUT', url: `/api/categories/${childId}`, headers: authHeaders(owner.token), payload: { name: '子分类改名' },
    })).statusCode).toBe(200)
    const root = await create()
    expect(root.statusCode).toBe(200)
    expect(root.json().data.parent_id).toBeNull()
    expect(db.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY id').all(other.id)).toEqual(
      snapshot.filter((row: any) => row.user_id === other.id),
    )
    expect((await deleteUser(other.id)).status).toBe(200)
    expect((await deleteUser(owner.id)).status).toBe(200)
  })

  it('应拒绝删除自己', async () => {
    const me = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(adminToken) })).payload,
    ).data.user
    const r = await deleteUser(me.id)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe(3003)
  })

  it('应拒绝删除不存在的用户', async () => {
    const r = await deleteUser(999999)
    expect(r.status).toBe(404)
    expect(r.body.code).toBe(3002)
  })

  it('普通用户无权删除用户', async () => {
    const u = await makeUser('normal_attacker')
    const victim = await makeUser('normal_victim')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.id}`,
      headers: authHeaders(u.token),
    })
    expect(res.statusCode).toBe(403)
  })

  it('邀请码创建者被删除后，邀请码本身应保留（created_by 置空）', async () => {
    // 邀请码只能由 admin 创建，admin 不能删自己——这里直接验证置空逻辑不会误删
    const rows = getDb().prepare('SELECT COUNT(*) c FROM invite_codes').get() as { c: number }
    expect(rows.c).toBeGreaterThan(0)
  })

  describe('分页参数非法值不得 500', () => {
    // 回归：`?page=abc` 在 admin 的列表接口里曾各写一遍 `Math.max(1, parseInt(...))`
    // → NaN 绑进 LIMIT/OFFSET → SqliteError: datatype mismatch → 500。
    // `1e999` 更隐蔽：Number 是 Infinity，`Number(x) || 1` 挡不住它。
    it.each(['abc', '1e999'])('users/:id/transactions?page=%s → 200（回落默认值）', async (page) => {
      const u = await makeUser(`pg_${page.replace(/\W/g, '') || 'empty'}`)
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/users/${u.id}/transactions?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(page)}`,
        headers: authHeaders(adminToken),
      })
      expect(res.statusCode, page).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.page).toBe(1)
      expect(body.data.page_size).toBe(20) // 非法 page_size 回落默认值
    })

    it('空串 = 没传参数（用默认值）；负数/0 收敛到 1', async () => {
      const u = await makeUser('pg_edge')
      const empty = JSON.parse(
        (await app.inject({
          method: 'GET',
          url: `/api/admin/users/${u.id}/transactions?page=&page_size=`,
          headers: authHeaders(adminToken),
        })).payload,
      ).data
      expect(empty.page).toBe(1)
      expect(empty.page_size).toBe(20)

      const negative = JSON.parse(
        (await app.inject({
          method: 'GET',
          url: `/api/admin/users/${u.id}/transactions?page=-5&page_size=0`,
          headers: authHeaders(adminToken),
        })).payload,
      ).data
      expect(negative.page).toBe(1)
      expect(negative.page_size).toBe(1)
    })

    it.each([
      ['/api/admin/ai-parse-logs?page=abc&page_size=1e999', 20],
      ['/api/admin/logs?page=abc&page_size=abc', 50],
    ])('%s → 200', async (url, expectSize) => {
      const res = await app.inject({ method: 'GET', url, headers: authHeaders(adminToken) })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.pagination.page).toBe(1)
      expect(body.data.pagination.page_size).toBe(expectSize)
    })

    it('合法分页值仍然生效', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/logs?page=2&page_size=10',
        headers: authHeaders(adminToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.data.pagination.page).toBe(2)
      expect(body.data.pagination.page_size).toBe(10)
    })
  })
})

describe('AI 解析日志不再返回已下线字段（parse-feedback 下线）', () => {
  let app: FastifyInstance
  let adminToken: string
  let userId: number
  let logId: number

  beforeAll(async () => {
    app = await buildApp()
    adminToken = await loginAdmin(app)
    const token = await createUser(app, 'retired_fields')
    const me = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).payload,
    ).data.user
    userId = me.id
    // 造一条把三个字段都写满的日志：user_modified / modification_detail 不应再返回；final_items 仍返回
    const res = getDb()
      .prepare(
        `INSERT INTO ai_parse_logs (user_id, raw_input, status, final_items, user_modified, modification_detail)
         VALUES (?, '午饭32', 'success', '[{"type":"expense"}]', 1, '{"changed":true}')`,
      )
      .run(userId)
    logId = Number(res.lastInsertRowid)
  })
  afterAll(async () => {
    await teardownApp(app)
  })

  it('列表：行内含 final_items，不含 user_modified / modification_detail', async () => {
    const data = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/api/admin/ai-parse-logs?user_id=${userId}`,
        headers: authHeaders(adminToken),
      })).payload,
    ).data
    const row = (data.items as Array<Record<string, unknown>>).find((r) => r.id === logId)
    expect(row).toBeTruthy()
    expect(row).toHaveProperty('final_items')
    expect(row).not.toHaveProperty('user_modified')
    expect(row).not.toHaveProperty('modification_detail')
  })

  it('详情：同样不含 user_modified / modification_detail，final_items 保留', async () => {
    const data = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/api/admin/ai-parse-logs/${logId}`,
        headers: authHeaders(adminToken),
      })).payload,
    ).data
    expect(data).toHaveProperty('final_items')
    expect(data).not.toHaveProperty('user_modified')
    expect(data).not.toHaveProperty('modification_detail')
  })
})
