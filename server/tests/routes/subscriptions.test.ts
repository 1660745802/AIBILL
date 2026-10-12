/**
 * 订阅管理路由集成测试
 * 覆盖: 创建(monthly/quarterly/yearly)、列表、月年总额计算、更新、取消续订、删除、用户隔离、next_payment_date
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { runScheduledTasks } from '../../src/services/scheduler.js'

describe('Subscription Routes', () => {
  let app: FastifyInstance
  let userToken: string
  let user2Token: string
  let userCategoryId: number
  let userAccountId: number

  beforeAll(async () => {
    app = await buildApp()
    userToken = await createUser(app, 'subuser1')
    user2Token = await createUser(app, 'subuser2')

    // Get user's first category
    const catRes = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: authHeaders(userToken),
    })
    const categories = JSON.parse(catRes.payload).data.items
    userCategoryId = categories.find((c: any) => c.type === 'expense').id

    // Get user's first account
    const accRes = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: authHeaders(userToken),
    })
    const accounts = JSON.parse(accRes.payload).data.items
    userAccountId = accounts[0].id
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/subscriptions', () => {
    it('should create a monthly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Netflix',
          amount: 1500,
          cycle: 'monthly',
          category_id: userCategoryId,
          account_id: userAccountId,
          start_date: '2026-01-01',
          reminder_days: 3,
          auto_record: false,
          note: '视频会员',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.name).toBe('Netflix')
      expect(body.data.amount).toBe(1500)
      expect(body.data.cycle).toBe('monthly')
      expect(body.data.next_payment_date).toBeDefined()
    })

    it('should create a quarterly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'iCloud 存储',
          amount: 2100,
          cycle: 'quarterly',
          start_date: '2026-01-15',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.cycle).toBe('quarterly')
    })

    it('should create a yearly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'GitHub Pro',
          amount: 48000,
          cycle: 'yearly',
          start_date: '2026-03-01',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.cycle).toBe('yearly')
    })

    it('should reject invalid amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Bad',
          amount: -100,
          cycle: 'monthly',
          start_date: '2026-01-01',
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should reject invalid category', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: {
          name: 'Bad Cat',
          amount: 1000,
          cycle: 'monthly',
          category_id: 99999,
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(400)
      expect(body.code).toBe(2003)
    })
  })

  describe('GET /api/subscriptions', () => {
    it('should list active subscriptions by default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.items.length).toBe(3)
      // All should have category_name or null
      for (const item of body.data.items) {
        expect(item).toHaveProperty('category_name')
        expect(item).toHaveProperty('account_name')
      }
    })

    it('should list all subscriptions when status=all', async () => {
      // First cancel one
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[items.length - 1].id

      await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/cancel`,
        headers: authHeaders(userToken),
      })

      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.data.items.length).toBe(3)

      // Active only should be 2
      const activeRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=active',
        headers: authHeaders(userToken),
      })
      const activeBody = JSON.parse(activeRes.payload)
      expect(activeBody.data.items.length).toBe(2)

      // Renew it back for subsequent tests
      await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/renew`,
        headers: authHeaders(userToken),
      })
    })

    it('should compute monthly_total and yearly_total', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)

      // Netflix monthly: 1500/month, 18000/year
      // iCloud quarterly: 2100/3=700/month, 2100*4=8400/year
      // GitHub yearly: 48000/12=4000/month, 48000/year
      const expectedMonthly = 1500 + Math.round(2100 / 3) + Math.round(48000 / 12)
      const expectedYearly = 1500 * 12 + 2100 * 4 + 48000

      expect(body.data.monthly_total).toBe(expectedMonthly)
      expect(body.data.yearly_total).toBe(expectedYearly)
    })
  })

  describe('PUT /api/subscriptions/:id', () => {
    it('should update subscription name and amount', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[0].id

      const res = await app.inject({
        method: 'PUT',
        url: `/api/subscriptions/${subId}`,
        headers: authHeaders(userToken),
        payload: { name: 'Netflix Premium', amount: 2500 },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.name).toBe('Netflix Premium')
      expect(body.data.amount).toBe(2500)
    })

    it('should recalculate next_payment_date when cycle changes', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const sub = items[0]
      const oldNext = sub.next_payment_date

      const res = await app.inject({
        method: 'PUT',
        url: `/api/subscriptions/${sub.id}`,
        headers: authHeaders(userToken),
        payload: { cycle: 'yearly' },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      // next_payment_date should be different since cycle changed
      expect(body.data.next_payment_date).not.toBe(oldNext)
    })

    it('should return 404 for non-existent subscription', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/subscriptions/99999',
        headers: authHeaders(userToken),
        payload: { name: 'Nonexistent' },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /api/subscriptions/:id/cancel', () => {
    it('should cancel a subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[0].id

      const res = await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subId}/cancel`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)

      // Verify it's cancelled
      const allRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=cancelled',
        headers: authHeaders(userToken),
      })
      const allBody = JSON.parse(allRes.payload)
      const cancelled = allBody.data.items.find((s: any) => s.id === subId)
      expect(cancelled).toBeDefined()
      expect(cancelled.status).toBe('cancelled')
    })
  })

  describe('POST /api/subscriptions/:id/renew', () => {
    it('should renew a cancelled subscription', async () => {
      const allRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=cancelled',
        headers: authHeaders(userToken),
      })
      const cancelled = JSON.parse(allRes.payload).data.items[0]

      const res = await app.inject({
        method: 'POST',
        url: `/api/subscriptions/${cancelled.id}/renew`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      expect(body.data.status).toBe('active')
      expect(body.data.next_payment_date).toBeDefined()
    })
  })

  describe('DELETE /api/subscriptions/:id', () => {
    it('should delete a subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      const subId = items[items.length - 1].id

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/subscriptions/${subId}`,
        headers: authHeaders(userToken),
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)

      // Verify it's gone
      const afterRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const afterItems = JSON.parse(afterRes.payload).data.items
      expect(afterItems.find((s: any) => s.id === subId)).toBeUndefined()
    })

    it('should return 404 for non-existent subscription', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/subscriptions/99999',
        headers: authHeaders(userToken),
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('User isolation', () => {
    it('should not allow user2 to see user1 subscriptions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(user2Token),
      })
      const body = JSON.parse(res.payload)
      expect(body.data.items.length).toBe(0)
    })

    it('should not allow user2 to update user1 subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      if (items.length > 0) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/subscriptions/${items[0].id}`,
          headers: authHeaders(user2Token),
          payload: { name: 'Hacked' },
        })
        expect(res.statusCode).toBe(404)
      }
    })

    it('should not allow user2 to delete user1 subscription', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/subscriptions?status=all',
        headers: authHeaders(userToken),
      })
      const items = JSON.parse(listRes.payload).data.items
      if (items.length > 0) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/subscriptions/${items[0].id}`,
          headers: authHeaders(user2Token),
        })
        expect(res.statusCode).toBe(404)
      }
    })
  })

  describe('start_date 的日历有效性（2026-13-01 / 2026-02-30 不能进库）', () => {
    const mk = (startDate: string) => ({
      name: '非法日期订阅',
      amount: 1000,
      cycle: 'monthly',
      category_id: userCategoryId,
      account_id: userAccountId,
      start_date: startDate,
    })

    it('格式对但不存在的日期必须 400，且不写库', async () => {
      for (const bad of ['2026-13-01', '2026-02-30', '2026-04-31', '2026-00-10']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/subscriptions',
          headers: authHeaders(userToken),
          payload: mk(bad),
        })
        expect(res.statusCode, bad).toBe(400)
        expect(JSON.parse(res.payload).code, bad).toBe(2000)
      }
      // 一行都不许落库：未校验时 '2026-13-01' 会被原样存进 next_payment_date，
      // 等到字典序追上 2027-01-01 时 scheduler 会记出一笔 date='2026-13-01'
      // 的账单（账本里多出幽灵账期 2026-13）
      const rows = getDb()
        .prepare("SELECT count(*) c FROM subscriptions WHERE start_date LIKE '2026-13%' OR start_date LIKE '%-02-30' OR start_date LIKE '%-04-31'")
        .get() as { c: number }
      expect(rows.c).toBe(0)
    })

    it('闰年 2028-02-29 是合法日期（不能把 refine 写成通配拒绝）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: mk('2028-02-29'),
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).data.next_payment_date).toBe('2028-02-29')
    })

    it('非安全整数金额应被拒（会经 scheduler 直接写进账本）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(userToken),
        payload: { ...mk('2026-12-01'), amount: 1e20 },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).code).toBe(2000)
    })
  })

  describe('next_payment_date calculation', () => {
    it('should calculate correct next_payment_date for monthly subscription', async () => {
      // Use a start_date in the past
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Monthly Test',
          amount: 1000,
          cycle: 'monthly',
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      // next_payment_date should be in the future
      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // It should be within the next month from now (at most)
      const oneMonthLater = new Date(now)
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1)
      oneMonthLater.setDate(oneMonthLater.getDate() + 1) // buffer
      expect(nextDate.getTime()).toBeLessThanOrEqual(oneMonthLater.getTime())
    })

    it('should calculate correct next_payment_date for quarterly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Quarterly Test',
          amount: 3000,
          cycle: 'quarterly',
          start_date: '2026-01-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // Should be within next 3 months
      const threeMonthsLater = new Date(now)
      threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3)
      threeMonthsLater.setDate(threeMonthsLater.getDate() + 1)
      expect(nextDate.getTime()).toBeLessThanOrEqual(threeMonthsLater.getTime())
    })

    it('should calculate correct next_payment_date for yearly subscription', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Yearly Test',
          amount: 12000,
          cycle: 'yearly',
          start_date: '2025-06-01',
        },
      })
      const body = JSON.parse(res.payload)
      const nextDate = new Date(body.data.next_payment_date)
      const now = new Date()

      expect(nextDate.getTime()).toBeGreaterThan(now.getTime())

      // Should be within next 12 months
      const oneYearLater = new Date(now)
      oneYearLater.setMonth(oneYearLater.getMonth() + 12)
      oneYearLater.setDate(oneYearLater.getDate() + 1)
      expect(nextDate.getTime()).toBeLessThanOrEqual(oneYearLater.getTime())
    })

    it('should set future start_date as next_payment_date', async () => {
      // If start_date is in the future, next_payment_date = start_date
      const futureDate = new Date()
      futureDate.setMonth(futureDate.getMonth() + 2)
      const futureDateStr = futureDate.toISOString().slice(0, 10)

      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(user2Token),
        payload: {
          name: 'Future Sub',
          amount: 5000,
          cycle: 'monthly',
          start_date: futureDateStr,
        },
      })
      const body = JSON.parse(res.payload)
      // Since start_date is in the future, it never enters the while loop
      // so next_payment_date should be the start_date itself
      expect(body.data.next_payment_date).toBe(futureDateStr)
    })
  })
})

/* ══════════════════════════════════════════════════════════════
   订阅自动记账对停用账户的处理（D3）

   这是**第三条**写余额的路径：scheduler 用裸 SQL 建账单、只经 applyTxn
   改余额，而 POST/PUT /transactions 在路由层查了 is_active=1、它没有。
   所以指向停用账户的订阅到期时，会改一个「任何读模型都看不到」的账户余额
   并推进基线——与 D3 要消灭的理由逐字相同。

   ⚠️ 守卫必须放在**挑订阅**这一步（正向），不能放进 applyTxn：
   applyTxn 正负两向都走，而撤销（删账单/还原）必须对停用账户生效，
   否则会造成永久错账（见 account-balance-model.test.ts 的 MAJOR-A 回归）。

   本文件守两条：跳过时**不产生任何账单/余额变化**，且 `next_payment_date`
   **不推进**（还原账户后下个周期会补上，不会漏记）。
   ══════════════════════════════════════════════════════════════ */
describe('订阅自动记账跳过停用账户（D3）', () => {
  let app: FastifyInstance
  let token: string
  let accId: number
  let catId: number

  const balanceOf = async (id: number): Promise<number> => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })
    return JSON.parse(res.payload).data.items.find((a: any) => a.id === id).current_balance
  }
  const txCount = async (): Promise<number> => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions', headers: authHeaders(token) })
    return JSON.parse(res.payload).data.items.length
  }

  async function makeSub(name: string): Promise<number> {
    const res = await app.inject({
      method: 'POST', url: '/api/subscriptions', headers: authHeaders(token),
      payload: {
        name, amount: 999, cycle: 'monthly',
        category_id: catId, account_id: accId,
        start_date: '2026-01-01', reminder_days: 3, auto_record: true,
      },
    })
    return JSON.parse(res.payload).data.id
  }

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'sub_inactive')
    const accs = JSON.parse((await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload).data.items
    accId = accs[0].id
    const cats = JSON.parse((await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(token) })).payload).data.items
    catId = cats.find((c: any) => c.type === 'expense').id
  })
  afterAll(async () => { await teardownApp(app) })

  const setDue = (id: number, date: string) =>
    getDb().prepare('UPDATE subscriptions SET next_payment_date = ? WHERE id = ?').run(date, id)

  it('指向停用账户的到期订阅：不记账、不改余额、next_payment_date 不推进', async () => {
    const subId = await makeSub('停用账户订阅')
    setDue(subId, '2020-01-01') // 确保到期

    // 停用账户（软删）
    await app.inject({ method: 'DELETE', url: `/api/accounts/${accId}`, headers: authHeaders(token) })

    const beforeBalance = getDb().prepare('SELECT balance FROM accounts WHERE id = ?').get(accId) as { balance: number }
    const beforeTx = getDb().prepare('SELECT count(*) c FROM transactions WHERE user_id = (SELECT user_id FROM accounts WHERE id = ?)').get(accId) as { c: number }

    await runScheduledTasks()

    const afterBalance = getDb().prepare('SELECT balance FROM accounts WHERE id = ?').get(accId) as { balance: number }
    const afterTx = getDb().prepare('SELECT count(*) c FROM transactions WHERE user_id = (SELECT user_id FROM accounts WHERE id = ?)').get(accId) as { c: number }
    const sub = getDb().prepare('SELECT next_payment_date FROM subscriptions WHERE id = ?').get(subId) as { next_payment_date: string }

    expect(afterBalance.balance).toBe(beforeBalance.balance)   // 余额没动
    expect(afterTx.c).toBe(beforeTx.c)                          // 没产生账单
    expect(sub.next_payment_date).toBe('2020-01-01')            // 不推进 ⇒ 还原后不会漏记
  })

  it('还原账户后，被跳过的订阅会**补记**（不漏记），已到期的都一次性补上', async () => {
    // 还原账户
    await app.inject({ method: 'POST', url: `/api/accounts/${accId}/restore`, headers: authHeaders(token), payload: {} })
    const subId = await makeSub('正常订阅')
    setDue(subId, '2020-01-01')

    const beforeBalance = await balanceOf(accId)
    await runScheduledTasks()
    const afterBalance = await balanceOf(accId)

    // 上一条被跳过的订阅（999）+ 本条新到期的（999）都补记了，
    // 因为它的 next_payment_date 没被推进 ⇒ 不会漏记。
    expect(afterBalance).toBe(beforeBalance - 999 * 2)

    // 两条都已推进 next_payment_date
    const sub = getDb().prepare('SELECT next_payment_date FROM subscriptions WHERE id = ?').get(subId) as { next_payment_date: string }
    expect(sub.next_payment_date).not.toBe('2020-01-01')
  })

  /*
    另一类「已经有了」必须区别对待：账单**已经在**（这一期已结算），
    与上面「账户停用 → 账单根本没建」相反。
    不推进日期的话 next_payment_date 永远停在过去：每跳重扫一遍 + 一条 warn，
    而该订阅往后的每一期都不会再自动记账。
  */
  it('付款日上已有账单（已结算）时：不重复记账，但 next_payment_date 必须推进', async () => {
    const countForSub = (id: number) => (getDb().prepare(
      `SELECT count(*) c FROM transactions
        WHERE source = 'subscription' AND source_detail = ? AND deleted_at IS NULL`,
    ).get(`subscription:${id}`) as { c: number }).c
    const nextOf = (id: number) => (getDb().prepare(
      'SELECT next_payment_date FROM subscriptions WHERE id = ?',
    ).get(id) as { next_payment_date: string }).next_payment_date

    const subId = await makeSub('已结算的订阅')
    setDue(subId, '2020-02-01')
    await runScheduledTasks()                     // 第一次：记账 + 推进
    expect(nextOf(subId)).not.toBe('2020-02-01')
    expect(countForSub(subId)).toBe(1)

    // 用户把付款日改回一个「已经有账单」的日期（订阅页改周期/起始日很容易落到这里）
    setDue(subId, '2020-02-01')
    await runScheduledTasks()

    expect(countForSub(subId)).toBe(1)            // 不重复记账
    expect(nextOf(subId)).not.toBe('2020-02-01')  // 不再卡死在那一期
  })
})
