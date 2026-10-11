/**
 * 账户余额模型：增量调整 + 手填覆盖（017）。
 *
 * 模型由用户定义：
 *   - 余额是存着的数（`accounts.balance`），不是每次重算
 *   - 有归属的账单增删改 → 增量加减余额
 *   - 手填 → 覆盖余额，并刷新基准线
 *
 * 不变量：balance == 上次手填的值 + 基准线之后所有有归属流水的增减。
 * 因为从不重放基准线之前的流水，手填修正不会被重复计算。
 *
 * 这些测试覆盖的是「实时影响账户 + 手填不被重复算」这条核心不变式。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'

describe('账户余额模型（增量 + 覆盖）', () => {
  let app: FastifyInstance
  let token: string
  let bankId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'balmodel')
    const accs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    bankId = accs.find((a: any) => a.name === '银行卡').id
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const addTxn = (fields: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: authHeaders(token),
      payload: { items: [fields] },
    })

  const balanceOf = async (id: number): Promise<number> => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })
    const items = JSON.parse(res.payload).data.items
    return items.find((a: any) => a.id === id).current_balance
  }

  it('有归属的支出实时扣减余额', async () => {
    const before = await balanceOf(bankId)
    await addTxn({ type: 'expense', amount: 5000, date: '2099-01-01', description: '测试支出', account_id: bankId })
    expect(await balanceOf(bankId)).toBe(before - 5000)
  })

  it('有归属的收入实时增加余额', async () => {
    const before = await balanceOf(bankId)
    await addTxn({ type: 'income', amount: 3000, date: '2099-01-02', description: '测试收入', account_id: bankId })
    expect(await balanceOf(bankId)).toBe(before + 3000)
  })

  it('删除账单会退回余额，撤销删除会再加回去（完全可逆）', async () => {
    const res = await addTxn({ type: 'expense', amount: 2000, date: '2099-01-03', description: '可逆支出', account_id: bankId })
    const created = JSON.parse(res.payload).data.created[0]
    const afterAdd = await balanceOf(bankId)

    await app.inject({ method: 'DELETE', url: `/api/transactions/${created.id}`, headers: authHeaders(token) })
    const afterDel = await balanceOf(bankId)
    expect(afterDel).toBe(afterAdd + 2000)

    await app.inject({ method: 'POST', url: `/api/transactions/${created.id}/restore`, headers: authHeaders(token) })
    expect(await balanceOf(bankId)).toBe(afterAdd) // 恢复后回到删除前的值
  })

  it('无归属的账单（不传 account_id）不动余额——旧客户端行为不变', async () => {
    const before = await balanceOf(bankId)
    await addTxn({ type: 'expense', amount: 9999, date: '2099-01-04', description: '无归属' })
    expect(await balanceOf(bankId)).toBe(before) // 余额不变
  })

  it('改金额会撤回旧值再应用新值', async () => {
    const res = await addTxn({ type: 'expense', amount: 1000, date: '2099-01-05', description: '待改金额', account_id: bankId })
    const id = JSON.parse(res.payload).data.created[0].id
    const afterAdd = await balanceOf(bankId)

    await app.inject({
      method: 'PUT',
      url: `/api/transactions/${id}`,
      headers: authHeaders(token),
      payload: { amount: 4000 },
    })
    // 1000 → 4000，多扣 3000
    expect(await balanceOf(bankId)).toBe(afterAdd - 3000)
  })

  it('手填覆盖后，基准线之前的历史账单不再重复计算', async () => {
    // 这是核心不变式：手填一次，然后去改那笔「已经烤进手填值里」的旧账，
    // 余额不能变——否则说明旧账被减了两次。
    // 账单日期必须早于手填基准线（基准线=今天），所以用过去的日期。
    const res = await addTxn({ type: 'expense', amount: 7777, date: '2020-01-06', description: '旧账', account_id: bankId })
    const id = JSON.parse(res.payload).data.created[0].id

    // 手填修正为一个绝对值（覆盖），基准线 = 今天
    await app.inject({
      method: 'PUT',
      url: `/api/accounts/${bankId}`,
      headers: authHeaders(token),
      payload: { current_balance: -12345 },
    })
    expect(await balanceOf(bankId)).toBe(-12345) // 覆盖生效

    // 编辑那笔基准线之前的旧账：余额不能变
    await app.inject({
      method: 'PUT',
      url: `/api/transactions/${id}`,
      headers: authHeaders(token),
      payload: { amount: 1 },
    })
    expect(await balanceOf(bankId)).toBe(-12345) // 未被重复计算 ✓
  })

  it('覆盖之后的新账单正常加减（这正是用户确认的行为）', async () => {
    // 承接上一个测试：余额是 -12345，新增一笔未来（有归属）的支出
    await addTxn({ type: 'expense', amount: 500, date: '2099-06-01', description: '新账', account_id: bankId })
    expect(await balanceOf(bankId)).toBe(-12345 - 500)
  })
})
/* ══════════════════════════════════════════════════════════════
   以下三条是 code review 实跑复现出来的阻断缺陷，回归锁死。
   ══════════════════════════════════════════════════════════════ */
describe('review 复现的阻断缺陷', () => {
  let app: FastifyInstance
  let aTok: string
  let bTok: string
  let aAcc: number
  let bAcc: number

  beforeAll(async () => {
    app = await buildApp()
    aTok = await createUser(app, 'rev_a')
    bTok = await createUser(app, 'rev_b')
    const pick = async (t: string, n: string) => {
      const items = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(t) })).payload,
      ).data.items
      return items.find((a: any) => a.name === n).id as number
    }
    aAcc = await pick(aTok, '银行卡')
    bAcc = await pick(bTok, '银行卡')
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  const bal = async (t: string, id: number) => {
    const items = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(t) })).payload,
    ).data.items
    return items.find((a: any) => a.id === id).current_balance
  }

  it('缺陷1：同一天第二次改余额不能 500（旧客户端和 Web 设置页的主路径）', async () => {
    // 旧实现用裸 INSERT 写 asset_snapshots，撞 UNIQUE(user_id,account_id,snapshot_date)
    // 就抛异常；而且 INSERT 在 UPDATE 之前，余额一点没改就失败了。
    const put = (v: number) =>
      app.inject({
        method: 'PUT', url: `/api/accounts/${aAcc}`,
        headers: authHeaders(aTok), payload: { current_balance: v },
      })

    const r1 = await put(11111)
    expect(r1.statusCode).toBe(200)
    expect(await bal(aTok, aAcc)).toBe(11111)

    const r2 = await put(22222)
    expect(r2.statusCode).toBe(200)          // 曾经是 500
    expect(await bal(aTok, aAcc)).toBe(22222)
  })

  it('缺陷2：不能把账单指向别人的账户（跨用户改余额）', async () => {
    const before = await bal(bTok, bAcc)
    const created = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/transactions', headers: authHeaders(aTok),
        payload: { items: [{ type: 'expense', amount: 700, date: '2099-01-01', description: 'x', account_id: aAcc }] },
      })).payload,
    ).data.created[0]

    const r = await app.inject({
      method: 'PUT', url: `/api/transactions/${created.id}`,
      headers: authHeaders(aTok), payload: { account_id: bAcc },
    })
    expect(r.statusCode).toBe(400)                 // 曾经是 200
    expect(await bal(bTok, bAcc)).toBe(before)     // B 的余额不能被 A 改
  })

  it('缺陷3：手填当天之后再记的账单必须进余额（与业务日期无关）', async () => {
    await app.inject({
      method: 'PUT', url: `/api/accounts/${aAcc}`,
      headers: authHeaders(aTok), payload: { current_balance: 55555 },
    })
    // 业务日期就是今天。旧的「日期 + <=」判据会把今天 >= 基准线(今天) 判成
    // 「已烤进手填值」而永久跳过，直接推翻用户确认的模型。
    await app.inject({
      method: 'POST', url: '/api/transactions', headers: authHeaders(aTok),
      payload: { items: [{ type: 'expense', amount: 300, date: new Date().toISOString().slice(0, 10), description: '当天', account_id: aAcc }] },
    })
    expect(await bal(aTok, aAcc)).toBe(55555 - 300)
  })
})

/* ══════════════════════════════════════════════════════════════
   请求级原子性

   缺陷（实测）：PUT /api/accounts/:id 同时改余额 + 改成重名的账户名，
   名字那步撞 UNIQUE(user_id,name) 抛错 → 余额已被覆盖、快照凭证行也已写入。
   现在整单回滚，且错误统一成 400/3001（与 POST /api/accounts 一致），不漏 SQLite 原文。
   ══════════════════════════════════════════════════════════════ */
describe('PUT /api/accounts/:id · 请求级原子性', () => {
  let app: FastifyInstance
  let token: string
  let bankId: number

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'atomic_put')
    const items = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    bankId = items.find((a: any) => a.name === '银行卡').id
  })

  afterAll(async () => { await teardownApp(app) })

  const hdr = () => authHeaders(token)
  const row = (id: number) =>
    getDb().prepare('SELECT name, balance, balance_as_of_txn_id FROM accounts WHERE id = ?').get(id) as any
  const snapCount = (id: number) =>
    getDb().prepare('SELECT count(*) c FROM asset_snapshots WHERE account_id = ?').get(id).c
  /** 每个用例自己造一个账户，夹具自足、互不依赖 */
  async function newAccount(name: string) {
    const id = JSON.parse((await app.inject({
      method: 'POST', url: '/api/accounts', headers: hdr(),
      payload: { name, type: 'bank', initial_balance: 1000 },
    })).payload).data.id as number
    return id
  }

  it('同一次请求里改余额 + 改成重名的字段：整单回滚，且错误不漏 SQLite 原文', async () => {
    const acc = await newAccount('待改名账户')
    await app.inject({
      method: 'POST', url: '/api/transactions', headers: hdr(),
      payload: { items: [{ type: 'expense', amount: 500, date: '2099-04-01', description: '前置', account_id: acc }] },
    })
    const before = row(acc)
    const snapsBefore = snapCount(acc)
    expect(before.balance).toBe(500)          // initial_balance 1000 − 500

    // 改成已存在的名字 → UNIQUE(user_id, name) 冲突
    const res = await app.inject({
      method: 'PUT', url: `/api/accounts/${acc}`, headers: hdr(),
      payload: { name: '微信', current_balance: 88888 },
    })
    // 与 POST /api/accounts 同一套错误码；响应里不该出现 "UNIQUE constraint failed"
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe(3001)
    expect(body.message).toBe('账户名称已存在')
    expect(res.payload).not.toContain('UNIQUE constraint failed')
    expect(res.payload).not.toContain('SQLITE')

    // 曾经：balance 变成 88888、快照多了一行，而客户端只看到 500
    expect(row(acc).balance).toBe(before.balance)
    expect(row(acc).name).toBe('待改名账户')
    expect(snapCount(acc)).toBe(snapsBefore)
    expect(row(acc).balance_as_of_txn_id).toBe(before.balance_as_of_txn_id)
  })

  it('正常路径：余额与其它字段一起改，两半都落库', async () => {
    const acc = await newAccount('正常改名')
    const res = await app.inject({
      method: 'PUT', url: `/api/accounts/${acc}`, headers: hdr(),
      // sort_order 是 updateAccountSchema 认的字段；不要塞 note（那是资产属性接口的字段，
      // 这里会被 Zod 静默剥离，断言它等于断言了一个不存在的东西）
      payload: { name: '工资卡', current_balance: 12345, sort_order: 7 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).code).toBe(0)
    expect(row(acc).name).toBe('工资卡')
    expect(row(acc).balance).toBe(12345)
    expect(snapCount(acc)).toBeGreaterThan(0)
    expect(
      getDb().prepare('SELECT sort_order FROM accounts WHERE id = ?').get(acc).sort_order,
    ).toBe(7)
  })

  it('校验失败（无字段）不产生任何写入', async () => {
    const acc = await newAccount('空更新')
    const before = row(acc)
    const snapsBefore = snapCount(acc)
    const res = await app.inject({
      method: 'PUT', url: `/api/accounts/${acc}`, headers: hdr(), payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe(2000)
    expect(row(acc).balance).toBe(before.balance)
    expect(snapCount(acc)).toBe(snapsBefore)
  })

  it('别人的账户仍然 404，且一个字节都不写', async () => {
    const acc = await newAccount('有主的账户')
    const before = row(acc)
    const snapsBefore = snapCount(acc)

    const other = await createUser(app, 'atomic_other')
    const res = await app.inject({
      method: 'PUT', url: `/api/accounts/${acc}`, headers: authHeaders(other),
      payload: { current_balance: 777 },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.payload).code).toBe(3002)
    // 断言对象是**被请求的那个账户**（跨用户写入的直接受害面），
    // 不是同用户下的另一个账户。
    expect(row(acc).balance).toBe(before.balance)
    expect(row(acc).name).toBe('有主的账户')
    expect(snapCount(acc)).toBe(snapsBefore)
  })
})

/* ══════════════════════════════════════════════════════════════
   停用账户不可写（D3）

   之前两条入口口径相反：
     PUT /api/assets/snapshots   → 守卫生效，拒（2001）
     PUT /api/accounts/:id       → 只校验归属，照写（余额 + 快照 + 推进基线）
   而写进去的余额**任何读模型都看不到**（readAccounts / readHistory /
   countAccounts 全过滤 is_active=1），用户以为记上了，实际没有。
   现在由 `setManualBalance` 统一拦，两条入口同生共死。
   ══════════════════════════════════════════════════════════════ */
describe('停用账户不可写余额（D3）', () => {
  let app: FastifyInstance
  let token: string
  let accId: number

  const row = () => getDb()
    .prepare('SELECT balance, balance_as_of_txn_id FROM accounts WHERE id = ?').get(accId) as
    { balance: number; balance_as_of_txn_id: number }
  const snapCount = () => (getDb()
    .prepare('SELECT count(*) c FROM asset_snapshots WHERE account_id = ?').get(accId) as { c: number }).c

  beforeAll(async () => {
    app = await buildApp()
    token = await createUser(app, 'inactive_write')
    const accs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    accId = accs.find((a: any) => a.name === '银行卡').id
    // 停用（软删）
    const del = await app.inject({
      method: 'DELETE', url: `/api/accounts/${accId}`, headers: authHeaders(token),
    })
    expect(del.statusCode).toBe(200)
    const after = getDb().prepare('SELECT is_active FROM accounts WHERE id = ?').get(accId) as { is_active: number }
    expect(after.is_active).toBe(0)
  })

  afterAll(async () => { await teardownApp(app) })

  it('PUT /api/accounts/:id 传 current_balance → 400/2001，且一个字节都不写', async () => {
    const before = row()
    const snapsBefore = snapCount()

    const r = await app.inject({
      method: 'PUT', url: `/api/accounts/${accId}`,
      headers: authHeaders(token),
      payload: { current_balance: 999999 },
    })

    // 不是 500：那会让用户看到「服务器错误」，完全看不懂发生了什么
    expect(r.statusCode).toBe(400)
    const body = JSON.parse(r.payload)
    expect(body.code).toBe(2001)
    expect(body.message).toMatch(/停用/)

    // 余额、基线、快照一个都没动
    expect(row().balance).toBe(before.balance)
    expect(row().balance_as_of_txn_id).toBe(before.balance_as_of_txn_id)
    expect(snapCount()).toBe(snapsBefore)
  })

  it('传 initial_balance 同样被拒（它也走 setManualBalance）', async () => {
    const before = row()
    const r = await app.inject({
      method: 'PUT', url: `/api/accounts/${accId}`,
      headers: authHeaders(token),
      payload: { initial_balance: 555 },
    })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.payload).code).toBe(2001)
    expect(row().balance).toBe(before.balance)
  })

  it('两条入口口径一致：/assets/snapshots 也拒，且用的是同一个 2001', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/assets/snapshots',
      headers: authHeaders(token),
      payload: { items: [{ account_id: accId, balance: 12345 }] },
    })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.payload).code).toBe(2001)
    expect(row().balance).not.toBe(12345)
  })

  it('仍然可以改停用账户的其它字段（改名等）——只拦余额写入', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/api/accounts/${accId}`,
      headers: authHeaders(token),
      payload: { name: '改个名' },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.payload).data.name).toBe('改个名')
  })

  it('恢复账户后可以正常写余额（拦截只针对停用态）', async () => {
    const r = await app.inject({
      method: 'POST', url: `/api/accounts/${accId}/restore`,
      headers: authHeaders(token),
      payload: {},
    })
    expect(JSON.parse(r.payload).code).toBe(0)

    const w = await app.inject({
      method: 'PUT', url: `/api/accounts/${accId}`,
      headers: authHeaders(token),
      payload: { current_balance: 4242 },
    })
    expect(w.statusCode).toBe(200)
    expect(row().balance).toBe(4242)
  })
})
