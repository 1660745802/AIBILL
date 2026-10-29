/**
 * 账单导入集成测试
 *
 * 回归三个修复点：
 * 1. 导入记录自动预填分类（此前 category_id 全为 NULL，分类统计完全看不到导入数据）
 * 2. 重复检测（此前同一文件导入两次金额直接翻倍）
 * 3. 批量上限从 50 提升到 200（此前真实微信/支付宝账单动辄上千行，整批失败）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

const WECHAT_HEADER = [
  '微信支付账单明细',
  '微信昵称:[测试]',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
].join('\n')

const WECHAT_FOOTER = '----------------------微信支付账单明细列表--------------------'

function wechatCsv(rows: string[]): string {
  return `${WECHAT_HEADER}\n${rows.join('\n')}\n${WECHAT_FOOTER}\n`
}

describe('Import Routes', () => {
  let app: FastifyInstance
  let token: string
  let categories: Array<{ id: number; name: string; type: string; icon: string }>

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'importer')
    const res = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: authHeaders(token),
    })
    categories = JSON.parse(res.payload).data.items
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  async function parseCsv(content: string, src = 'wechat') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/csv',
      headers: authHeaders(token),
      payload: { content, source: src },
    })
    return { status: res.statusCode, body: JSON.parse(res.payload) }
  }

  const catId = (name: string, type = 'expense') =>
    categories.find((c) => c.name === name && c.type === type)!.id

  describe('分类预填', () => {
    it('应把美团/饿了么归入餐饮', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-20 12:30:00,商户消费,美团,"外卖订单",支出,¥32.50,零钱,支付成功,1,,',
          '2026-09-20 19:00:00,商户消费,饿了么,"晚餐",支出,¥45.00,零钱,支付成功,2,,',
        ]),
      )
      expect(body.code).toBe(0)
      expect(body.data.parsed).toHaveLength(2)
      for (const item of body.data.parsed) {
        expect(item.category_id).toBe(catId('餐饮'))
        expect(item.category_name).toBe('餐饮')
        expect(item.category_auto).toBe(true)
      }
    })

    it('美团单车→交通、美团会员→娱乐（不被笼统的“美团→餐饮”吃掉）', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-20 08:00:00,商户消费,美团单车,骑行,支出,¥1.50,零钱,支付成功,11,,',
          '2026-09-20 20:00:00,商户消费,美团会员,会员费,支出,¥15.00,零钱,支付成功,12,,',
        ]),
      )
      expect(body.data.parsed.map((i: any) => i.category_name)).toEqual(['交通', '娱乐'])
    })

    it('应把滴滴/地铁归入交通', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-21 09:00:00,商户消费,滴滴出行,网约车,支出,¥18.00,零钱,支付成功,3,,',
          '2026-09-21 09:30:00,商户消费,北京地铁,乘车码,支出,¥5.00,零钱,支付成功,4,,',
        ]),
      )
      expect(body.data.parsed.map((i: any) => i.category_name)).toEqual(['交通', '交通'])
    })

    it('应把超市/淘宝归入购物', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-22 10:00:00,商户消费,永辉超市,购物,支出,¥128.80,零钱,支付成功,5,,',
          '2026-09-22 11:00:00,商户消费,淘宝网,耳机,支出,¥299.00,零钱,支付成功,6,,',
        ]),
      )
      expect(body.data.parsed.map((i: any) => i.category_name)).toEqual(['购物', '购物'])
    })

    it('应把工资收入归入收入分类“工资”', async () => {
      const { body } = await parseCsv(
        wechatCsv(['2026-09-25 10:00:00,转账,公司,代发工资,收入,¥12000.00,零钱,已存入零钱,7,,']),
      )
      expect(body.data.parsed[0].type).toBe('income')
      expect(body.data.parsed[0].category_name).toBe('工资')
    })

    it('无法识别的商户应兜底到“其他”', async () => {
      const { body } = await parseCsv(
        wechatCsv(['2026-09-26 08:00:00,商户消费,张三明,不明支出,支出,¥66.00,零钱,支付成功,8,,']),
      )
      expect(body.data.parsed[0].category_name).toBe('其他')
    })

    it('转账类型不预填分类', async () => {
      const { body } = await parseCsv(
        wechatCsv(['2026-09-27 08:00:00,转账,微信零钱,零钱充值,不计收支,¥100.00,零钱,已存入零钱,9,,']),
      )
      // “不计收支”被跳过，parsed 为空
      expect(body.data.parsed).toHaveLength(0)
    })

    it('用户删除某分类后，命中该分类的记录应回退到“其他”', async () => {
      const t2 = await createUser(app, 'importer_nofood')
      // 停用“餐饮”
      const cats = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(t2) })).payload,
      ).data.items
      const food = cats.find((c: any) => c.name === '餐饮')
      await app.inject({
        method: 'DELETE',
        url: `/api/categories/${food.id}`,
        headers: authHeaders(t2),
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/import/csv',
        headers: authHeaders(t2),
        payload: { content: wechatCsv(['2026-09-20 12:00:00,商户消费,美团,外卖,支出,¥30.00,零钱,支付成功,10,,']), source: 'wechat' },
      })
      const parsed = JSON.parse(res.payload).data.parsed
      expect(parsed[0].category_name).toBe('其他')
    })
  })

  describe('重复检测', () => {
    it('首次解析不应标记重复', async () => {
      const { body } = await parseCsv(
        wechatCsv(['2026-09-10 12:00:00,商户消费,美团,外卖,支出,¥52.00,零钱,支付成功,d1,,']),
      )
      expect(body.data.duplicates).toBe(0)
      expect(body.data.parsed[0].duplicate).toBe(false)
    })

    it('入库后重新解析同一文件应全部标记为重复', async () => {
      const csv = wechatCsv(['2026-09-10 12:00:00,商户消费,美团,外卖,支出,¥52.00,零钱,支付成功,d1,,'])

      // 第一次：提交入库
      const first = await parseCsv(csv)
      const item = first.body.data.parsed[0]
      const created = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(token),
        payload: {
          items: [{ client_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', type: 'expense', amount: item.amount, date: item.date, description: item.description, category_id: item.category_id }],
        },
      })
      expect(JSON.parse(created.payload).data.created).toHaveLength(1)

      // 第二次：应识别为重复
      const second = await parseCsv(csv)
      expect(second.body.data.duplicates).toBe(1)
      expect(second.body.data.parsed[0].duplicate).toBe(true)
    })

    it('已删除（回收站）的记录不算重复', async () => {
      const csv = wechatCsv(['2026-09-11 12:00:00,商户消费,美团,午餐,支出,¥33.00,零钱,支付成功,d2,,'])
      const first = await parseCsv(csv)
      const item = first.body.data.parsed[0]
      const created = JSON.parse(
        (
          await app.inject({
            method: 'POST',
            url: '/api/transactions',
            headers: authHeaders(token),
            payload: { items: [{ type: 'expense', amount: item.amount, date: item.date, description: item.description, category_id: item.category_id }] },
          })
        ).payload,
      )
      expect(created.data.created).toHaveLength(1)

      await app.inject({
        method: 'DELETE',
        url: `/api/transactions/${created.data.created[0].id}`,
        headers: authHeaders(token),
      })

      const again = await parseCsv(csv)
      expect(again.body.data.duplicates).toBe(0)
    })

    it('同一批次内的完全相同记录也应标记重复', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-12 12:00:00,商户消费,美团,午餐,支出,¥33.00,零钱,支付成功,d3,,',
          '2026-09-12 12:00:00,商户消费,美团,午餐,支出,¥33.00,零钱,支付成功,d4,,',
        ]),
      )
      expect(body.data.duplicates).toBe(1)
      expect(body.data.parsed[0].duplicate).toBe(false)
      expect(body.data.parsed[1].duplicate).toBe(true)
    })
  })

  describe('批量上限', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        client_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        type: 'expense' as const,
        amount: 100 + i,
        date: '2026-09-01',
        description: `bulk-${i}`,
      }))

    it('应接受 200 条（导入分片大小）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(token),
        payload: { items: mk(200) },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).data.created).toHaveLength(200)
    })

    it('应拒绝 201 条并给出明确提示', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(token),
        payload: { items: [...mk(200), { type: 'expense', amount: 999, date: '2026-09-01', description: 'over' }] },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).message).toContain('200')
    })
  })

  describe('导入后统计可见性', () => {
    it('导入的记录应出现在分类统计中', async () => {
      const t3 = await createUser(app, 'importer_stats')
      const cats = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/categories', headers: authHeaders(t3) })).payload,
      ).data.items
      const food = cats.find((c: any) => c.name === '餐饮').id

      const parsed = JSON.parse(
        (
          await app.inject({
            method: 'POST',
            url: '/api/import/csv',
            headers: authHeaders(t3),
            payload: { content: wechatCsv(['2026-09-15 12:00:00,商户消费,美团,外卖,支出,¥40.00,零钱,支付成功,s1,,']), source: 'wechat' },
          })
        ).payload,
      ).data.parsed

      await app.inject({
        method: 'POST',
        url: '/api/transactions',
        headers: authHeaders(t3),
        payload: { items: [{ type: 'expense', amount: parsed[0].amount, date: parsed[0].date, description: parsed[0].description, category_id: parsed[0].category_id ?? food }] },
      })

      const stats = JSON.parse(
        (
          await app.inject({
            method: 'GET',
            url: '/api/stats/by-category?year=2026&month=9',
            headers: authHeaders(t3),
          })
        ).payload,
      )
      const foodRow = stats.data.items.find((i: any) => i.name === '餐饮')
      expect(foodRow).toBeDefined()
      expect(foodRow.total).toBe(4000)
    })

    it.each(['expense', 'income'])('%s 未分类也计入排行，合计/笔数与 summary 一致', async (type) => {
      const username = `uncat_${type}`
      const token = await createUser(app, username)
      const db = getDb()
      const { id: userId } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }
      const { id: categoryId } = db.prepare('SELECT id FROM categories WHERE user_id = ? AND type = ? LIMIT 1').get(userId, type) as { id: number }
      const categoriesBefore = db.prepare('SELECT * FROM categories WHERE user_id = ?').all(userId)
      const insert = db.prepare(`INSERT INTO transactions (user_id, type, amount, category_id, date, status, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      insert.run(userId, type, 3000, categoryId, '2026-09-01', 'confirmed', null)
      insert.run(userId, type, 1000, null, '2026-09-05', 'confirmed', null)
      insert.run(userId, type, 2000, null, '2026-09-30', 'confirmed', null)
      insert.run(userId, type, 9000, null, '2026-09-05', 'pending', null)
      insert.run(userId, type, 9000, null, '2026-09-05', 'confirmed', '2026-09-06')
      insert.run(userId, type, 9000, null, '2026-10-01', 'confirmed', null)
      insert.run(userId, type, 9000, null, '2026-08-31', 'confirmed', null)
      insert.run(userId, 'transfer', 9000, null, '2026-09-05', 'confirmed', null)
      const otherId = (db.prepare('SELECT id FROM users WHERE username = ?').get('importer') as { id: number }).id
      insert.run(otherId, type, 9000, null, '2026-09-05', 'confirmed', null)

      const get = async (url: string) => {
        const res = await app.inject({ method: 'GET', url, headers: authHeaders(token) })
        expect(res.statusCode).toBe(200)
        return JSON.parse(res.payload).data
      }
      const result = await get(`/api/stats/by-category?year=2026&month=9&type=${type}`)
      const summary = await get('/api/stats/summary?year=2026&month=9')
      expect(result.total).toBe(6000)
      expect(result.total).toBe(summary[type])
      expect(result.items.reduce((n: number, r: any) => n + r.count, 0)).toBe(summary[`${type}_count`])
      expect(result.items).toHaveLength(2)
      expect(result.items.find((r: any) => r.id === 0)).toEqual({
        id: 0, name: '未分类', icon: expect.any(String), total: 3000, count: 2, percent: 50,
      })
      for (const r of result.items) {
        // Android CategoryStatDto 的字段均为非空；虚拟分组也维持原响应形状。
        for (const k of ['id', 'total', 'count', 'percent']) expect(typeof r[k]).toBe('number')
        for (const k of ['name', 'icon']) expect(typeof r[k]).toBe('string')
        expect(r.percent).toBe(50)
      }
      expect(db.prepare('SELECT * FROM categories WHERE user_id = ?').all(userId)).toEqual(categoriesBefore)
      expect((await get(`/api/stats/by-category?year=2020&month=1&type=${type}`)).items).toEqual([])
    })
  })

  it('参数校验失败应返回 2000 而非 code:1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/csv',
      headers: authHeaders(token),
      payload: { content: '', source: 'unknown' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2000)
  })

  it('不存在的用户分类不应被写入（外键安全）', async () => {
    // 预填只会命中当前用户自己的分类，构造断言确认 category_id 均属于本用户
    const rows = getDb()
      .prepare('SELECT DISTINCT category_id FROM transactions WHERE user_id = ? AND category_id IS NOT NULL')
      .all(2) as Array<{ category_id: number }>
    const ownerIds = new Set(categories.map((c) => c.id))
    for (const r of rows) {
      expect(ownerIds.has(r.category_id)).toBe(true)
    }
  })

  describe('支付宝状态与真实导出列', () => {
    const header = '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态'
    const row = (id: number, status: string, direction = '支出', refund = '0.00') =>
      `${id}\t,order-${id}\t,2026-09-05 12:30:00,2026-09-05 12:31:00,2026-09-05 13:00:00,支付宝,即时到账,商户,"商品,${id}",100.00,${direction}, ${status} ,0.00,${refund},,已支出`

    it('未付款、等待付款和交易关闭不进入可入账预览', async () => {
      const statuses = ['未付款', '等待付款', '等待买家付款', '交易关闭', '交易取消', '支付失败']
      const { body } = await parseCsv([header, ...statuses.map((s, i) => row(i, s)), row(9, '交易成功')].join('\n'), 'alipay')
      expect(body.data.parsed).toHaveLength(1)
      expect(body.data.parsed[0]).toMatchObject({ description: '商品,9', type: 'expense', amount: 10000 })
      expect(body.data).toMatchObject({ total: 7, skipped: 6, errors: 0 })
    })

    it('不按“退款”字样或退款金额删有效交易，也不自动净额化', async () => {
      const { body } = await parseCsv([
        header,
        row(1, '交易成功', '支出', '20.00'),
        row(2, '交易成功', '支出', '100.00'),
        row(3, '退款成功', '收入', '100.00'),
        row(4, '交易成功', '不计收支', '100.00'),
      ].join('\n'), 'alipay')
      expect(body.data.parsed.map((r: any) => [r.type, r.amount])).toEqual([
        ['expense', 10000], ['expense', 10000], ['income', 10000],
      ])
      expect(body.data).toMatchObject({ total: 4, skipped: 1, errors: 0 })
    })

    it('移动端“交易时间”开头、不同列位置的导出同样按状态过滤', async () => {
      const { body } = await parseCsv([
        '支付宝交易明细',
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
        '2026-09-05 12:30:00,餐饮美食,美团,商户账号,午餐,支出,32.50,余额,交易关闭,id1,m1,',
        '2026-09-05 12:35:00,餐饮美食,美团,商户账号,晚餐,支出,40.00,余额,交易成功,id2,m2,',
        '2026-09-05 13:00:00,退款,美团,商户账号,退款到账,收入,10.00,余额,退款成功,id3,m3,',
      ].join('\n'), 'alipay')
      expect(body.data).toMatchObject({ total: 3, skipped: 1, errors: 0 })
      expect(body.data.parsed.map((r: any) => [r.description, r.type, r.amount])).toEqual([
        ['晚餐', 'expense', 4000], ['退款到账', 'income', 1000],
      ])
    })

    it('没有状态列的旧 CSV 保持兼容', async () => {
      const { body } = await parseCsv([
        '账务流水号,交易时间,交易对方,商品说明,金额（元）,收/支',
        'old1,2026-09-05 12:30:00,商户,旧账单,32.50,支出',
      ].join('\n'), 'alipay')
      expect(body.data).toMatchObject({ total: 1, skipped: 0, errors: 0 })
      expect(body.data.parsed[0]).toMatchObject({ type: 'expense', amount: 3250 })
    })
  })

  describe('日期与金额边界（预览必须与 POST /transactions 的校验一致）', () => {
    const ALIPAY_HEADER =
      '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态'
    const alipayCsv = (rows: string[]) => `${ALIPAY_HEADER}\n${rows.join('\n')}\n`

    it('单位数月/日的日期应补零成 YYYY-MM-DD（否则提交时被 400 整批拒掉）', async () => {
      const { body } = await parseCsv(
        alipayCsv([
          '202609051230001,x1,2026/9/5 12:30,2026/9/5 12:31,2026/9/5 12:31,支付宝,即时到账,张三,午餐,32.50,支出,交易成功',
        ]),
        'alipay',
      )
      expect(body.code).toBe(0)
      expect(body.data.parsed).toHaveLength(1)
      expect(body.data.parsed[0].date).toBe('2026-09-05')
      expect(body.data.parsed[0].amount).toBe(3250)
    })

    it('非法日期应计入 errors，不进预览', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-13-45 12:00:00,商户消费,美团,外卖,支出,¥32.00,零钱,支付成功,b1,,',
          '不是日期,商户消费,美团,外卖,支出,¥33.00,零钱,支付成功,b2,,',
        ]),
      )
      expect(body.data.parsed).toHaveLength(0)
      expect(body.data.errors).toBe(3) // 2 条坏日期 + 尾部横线行
    })

    it('0 元 / 负金额行应计入 errors（POST 只收 amount>0）', async () => {
      const { body } = await parseCsv(
        wechatCsv([
          '2026-09-20 12:00:00,商户消费,美团,0元单,支出,¥0.00,零钱,支付成功,z1,,',
          '2026-09-20 13:00:00,商户消费,美团,负数,支出,-32.00,零钱,退款,z2,,',
        ]),
      )
      expect(body.data.parsed).toHaveLength(0)
      expect(body.data.errors).toBe(3) // 2 条坏金额 + 尾部横线行
    })
  })
})
