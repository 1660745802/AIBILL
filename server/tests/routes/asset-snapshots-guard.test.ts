import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

/**
 * `asset_snapshots` 写路径的守卫测试。
 *
 * 背景：2026-10 删除了 deprecated 的 `GET /api/assets/trend` 与
 * `POST /api/assets/snapshot`。**只删路由，不删表**——
 * 这张表同时是 `GET /api/assets/portfolio` 读模型（曲线、覆盖率、构成）的数据源，
 * 也是 `PUT /api/assets/snapshots` 手填时的凭证行。
 *
 * 危险在于它长得像「跟已删端点同名的表」：下一个人清理时很容易顺手把表也删了，
 * 于是 portfolio 曲线静默变空、手填余额不再留痕，而**删表本身不会有任何报错**。
 * 这个测试就是那道「删了会静默坏掉」的护栏。
 */
describe('asset_snapshots 表仍被现役接口使用（删表会静默坏掉）', () => {
  let app: FastifyInstance
  let token: string
  let accountId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'snapshot_guard')
    const items = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    accountId = items.find((a: any) => a.name === '银行卡').id as number
  })
  afterAll(async () => { await teardownApp(app) })

  it('PUT /api/assets/snapshots 手填会落一行快照凭证', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/assets/snapshots',
      headers: authHeaders(token),
      payload: { items: [{ account_id: accountId, balance: 4200 }] },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).code).toBe(0)

    const row = getDb()
      .prepare('SELECT balance, source FROM asset_snapshots WHERE account_id = ?')
      .get(accountId) as { balance: number; source: string }
    expect(row.balance).toBe(4200)
    expect(row.source).toBe('manual')
  })

  it('该行会被 portfolio 读模型读到（曲线不是空的）', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token),
    })
    expect(r.statusCode).toBe(200)
    const curve = JSON.parse(r.payload).data.curve as unknown[]
    expect(curve.length).toBeGreaterThan(0)
  })

  it('同一天重复手填走 upsert 覆盖，不新增行', async () => {
    for (const balance of [111, 222]) {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/assets/snapshots',
        headers: authHeaders(token),
        payload: { items: [{ account_id: accountId, balance }] },
      })
      expect(r.statusCode).toBe(200)
    }
    const c = getDb()
      .prepare('SELECT COUNT(*) c FROM asset_snapshots WHERE account_id = ?')
      .get(accountId) as { c: number }
    // 三个夹具账户 + 银行卡，同一天只有一行
    expect(c.c).toBe(1)
  })
})