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
})
