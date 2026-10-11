import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

/**
 * `asset_snapshots` 的读写护栏。
 *
 * 背景：2026-10 删除了 deprecated 的 `GET /api/assets/trend` 与
 * `POST /api/assets/snapshot`。**只删路由，不删表**——
 * 这张表同时是 `GET /api/assets/portfolio` 读模型（曲线、覆盖率、构成）
 * 与 `GET /api/stats/dashboard` / `POST /api/stats/analysis` 净资产的数据源，
 * 也是 `PUT /api/assets/snapshots` 手填时的凭证行。
 *
 * ## 删表的后果是什么（审查 F3 更正过说法）
 *
 * 早先这里写的是「删表不会报错、只会静默坏掉」，**那是错的**。实测
 * `DROP TABLE asset_snapshots` 后三条用例全部 500：`setManualBalance` 的
 * `INSERT INTO asset_snapshots` 与 `readHistory` 的 `FROM asset_snapshots`
 * 都会抛 `no such table` 直接冒泡。
 *
 * 所以严重性要按**故障**算，不是按「显示不对」算：删表会让
 * portfolio / dashboard / analysis / 快照写入**四个端点集体 500**。
 * 写在这里是为了让下一个人知道这张表的依赖面有多大，而不是让人以为
 * 它只是「曲线会变空」那种可以慢慢发现的问题。
 *
 * ## 每条用例自己写自己的数据
 *
 * 不让用例之间共享写入（审查 NIT-5）：`vitest -t` 单跑某一条必须也能绿。
 */
describe('asset_snapshots 表仍被现役接口读写', () => {
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

  const snapOf = () =>
    getDb().prepare('SELECT balance, source FROM asset_snapshots WHERE account_id = ? ORDER BY id').all(accountId) as
      Array<{ balance: number; source: string }>

  it('PUT /api/assets/snapshots 手填会落一行快照凭证', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/assets/snapshots',
      headers: authHeaders(token),
      payload: { items: [{ account_id: accountId, balance: 4200 }] },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).code).toBe(0)

    const rows = snapOf()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.balance).toBe(4200)
    expect(rows[0]!.source).toBe('manual')
  })

  it('该行会被 portfolio 读模型读到（曲线不是空的）', async () => {
    // 自己写，不依赖上一条（顺序耦合会让 `-t` 单跑变红）
    await app.inject({
      method: 'PUT', url: '/api/assets/snapshots', headers: authHeaders(token),
      payload: { items: [{ account_id: accountId, balance: 7777 }] },
    })

    const r = await app.inject({
      method: 'GET', url: '/api/assets/portfolio', headers: authHeaders(token),
    })
    expect(r.statusCode).toBe(200)
    const curve = JSON.parse(r.payload).data.curve as unknown[]
    expect(curve.length).toBeGreaterThan(0)
  })

  it('同一天重复手填走 upsert 覆盖：**值**要变，不只是不新增行', async () => {
    /**
     * 审查 F2：只断言 `COUNT(*) === 1` 是恒真的——把
     * `ON CONFLICT ... DO UPDATE SET balance = excluded.balance` 改成
     * `DO NOTHING` 也照样绿。真正的语义是**第二次的值要覆盖第一次**。
     *
     * 不覆盖的实际后果：`accounts.balance` 是新值、`asset_snapshots.balance`
     * 是旧值 ⇒ portfolio 曲线当天的点静默取到旧余额。
     */
    for (const balance of [111, 222]) {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/assets/snapshots',
        headers: authHeaders(token),
        payload: { items: [{ account_id: accountId, balance }] },
      })
      expect(r.statusCode).toBe(200)
    }

    const rows = snapOf()
    // 同一天只留一行……
    expect(rows).toHaveLength(1)
    // ……但值必须是**最后一次**写入的 222，不是 111
    expect(rows[0]!.balance).toBe(222)
  })
})
