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
import { recordBalanceSamples } from '../../src/lib/account-balance.js'

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
   legacy `POST /api/assets/snapshot` 的写入路径

   它现在是 account-balance module 的第三个入口（recordBalanceSamples），
   路由里不再有任何直接推进基线的 SQL。下面锁死它与手填路径的**语义差异**：
   覆盖 vs 跳过、无条件推进 vs 仅首次推进。哪天有人图省事把它换成
   setManualBalance(currentBalance)，下面第 2 条会立刻红。
   ══════════════════════════════════════════════════════════════ */
describe('legacy POST /api/assets/snapshot · 采样语义', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await teardownApp(app) })

  /**
   * 每条用例**自己建一个用户**。
   *
   * 这个端点一次采样该用户**所有**活跃非理财账户，所以共用一个用户就必然有
   * 跨用例状态：「今天已有采样行」会让 `ON CONFLICT DO NOTHING` 整批跳过，
   * 于是后面的用例在前面的用例出错或被单独跑时测不出东西。
   * 新用户 = 4 个默认账户、余额 0、基线 0、无任何快照行，是最干净的夹具。
   */
  async function freshUser(tag: string) {
    const token = await createUser(app, tag)
    const items = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders(token) })).payload,
    ).data.items
    return {
      token,
      hdr: () => authHeaders(token),
      bankId: items.find((a: any) => a.name === '银行卡').id as number,
      wechatId: items.find((a: any) => a.name === '微信').id as number,
    }
  }

  const row = (id: number) =>
    getDb().prepare('SELECT balance, balance_as_of_txn_id FROM accounts WHERE id = ?').get(id) as any
  const snapsOf = (accountId: number) =>
    getDb().prepare(
      'SELECT balance, snapshot_date, source FROM asset_snapshots WHERE account_id = ? ORDER BY id',
    ).all(accountId) as any[]
  const maxTxnOf = (uid: number) =>
    (getDb().prepare('SELECT COALESCE(MAX(id),0) m FROM transactions WHERE user_id = ?')
      .get(uid) as any).m
  const uidOf = (accountId: number) =>
    (getDb().prepare('SELECT user_id FROM accounts WHERE id = ?').get(accountId) as any).user_id

  it('1. 首次：写采样行、推进基线到 MAX(txn)，但不改 balance', async () => {
    const u = await freshUser('snap_first')
    const uid = uidOf(u.bankId)

    await app.inject({
      method: 'POST', url: '/api/transactions', headers: u.hdr(),
      payload: { items: [{ type: 'expense', amount: 1000, date: '2099-03-01', description: '采样前', account_id: u.bankId }] },
    })
    expect(row(u.bankId).balance).toBe(-1000)
    expect(row(u.bankId).balance_as_of_txn_id).toBe(0)

    const res = JSON.parse((await app.inject({
      method: 'POST', url: '/api/assets/snapshot', headers: u.hdr(),
    })).payload)
    expect(res.code).toBe(0)
    // 响应契约：data 的键与文案一字不改（已发布端点）
    expect(Object.keys(res.data).sort()).toEqual(['created', 'date', 'skipped', 'total'])
    expect(res.data.created).toBe(4)     // 4 个默认账户，全部活跃且非理财
    expect(res.data.skipped).toBe(0)
    expect(res.data.total).toBe(4)
    expect(res.message).toBe('已记录 4 个账户快照')

    // 采样行 = 当时的权威余额，source=manual，日期与响应一致
    const snaps = snapsOf(u.bankId)
    expect(snaps).toHaveLength(1)
    expect(snaps[0].balance).toBe(-1000)
    expect(snaps[0].source).toBe('manual')
    expect(snaps[0].snapshot_date).toBe(res.data.date)

    // 基线推进到此刻的 MAX(txn)；balance 一个字节都没动
    expect(row(u.bankId).balance_as_of_txn_id).toBe(maxTxnOf(uid))
    expect(row(u.bankId).balance).toBe(-1000)
  })

  it('2. 同日重复：不覆盖、不推进基线，新建的账单之后仍可修正（最要害的一条）', async () => {
    const u = await freshUser('snap_twice')
    const post = () => app.inject({ method: 'POST', url: '/api/assets/snapshot', headers: u.hdr() })

    await app.inject({
      method: 'POST', url: '/api/transactions', headers: u.hdr(),
      payload: { items: [{ type: 'expense', amount: 1000, date: '2099-03-01', description: '第一次采样前', account_id: u.bankId }] },
    })
    JSON.parse((await post()).payload)
    const before = row(u.bankId)

    // 在第一次采样**之后**新建一笔账：它的 id 已经高于基线
    const t2 = JSON.parse((await app.inject({
      method: 'POST', url: '/api/transactions', headers: u.hdr(),
      payload: { items: [{ type: 'expense', amount: 2000, date: '2099-03-02', description: '采样后新建', account_id: u.bankId }] },
    })).payload).data.created[0]
    const afterAdd = before.balance - 2000
    expect(row(u.bankId).balance).toBe(afterAdd)
    expect(row(u.bankId).balance_as_of_txn_id).toBe(before.balance_as_of_txn_id)

    // 今天第二次点快照：整批跳过
    const res = JSON.parse((await post()).payload)
    expect(res.data.created).toBe(0)
    expect(res.data.skipped).toBe(res.data.total)
    expect(res.message).toBe('今日快照已存在')

    // 基线**没有**前进，已有采样行也没被覆盖
    expect(row(u.bankId).balance_as_of_txn_id).toBe(before.balance_as_of_txn_id)
    expect(snapsOf(u.bankId)).toHaveLength(1)
    expect(snapsOf(u.bankId)[0].balance).toBe(before.balance)

    // 因此这笔账没有被「烤进」余额：改它，余额必须跟着动。
    // 若哪天把这里换成 setManualBalance（无条件推进基线），这一条会红。
    await app.inject({
      method: 'PUT', url: `/api/transactions/${t2.id}`, headers: u.hdr(), payload: { amount: 500 },
    })
    expect(row(u.bankId).balance).toBe(afterAdd + 1500)   // 支出 2000 → 500，少扣 1500
  })

  it('3. 理财账户被排除：不进 total、无采样行、基线不动', async () => {
    const u = await freshUser('snap_inv')
    getDb().prepare("UPDATE accounts SET asset_type='investment' WHERE id=?").run(u.wechatId)

    const res = JSON.parse((await app.inject({
      method: 'POST', url: '/api/assets/snapshot', headers: u.hdr(),
    })).payload)

    // 新用户本来就没有任何采样行，所以「仍无行」只能由「根本没采样它」解释
    expect(snapsOf(u.wechatId)).toHaveLength(0)
    expect(row(u.wechatId).balance_as_of_txn_id).toBe(0)
    expect(res.data.total).toBe(3)          // 4 个默认账户减掉 1 个理财
    expect(res.data.created).toBe(3)
  })

  it('4. 停用账户被排除：不进 total、无采样行', async () => {
    const u = await freshUser('snap_inactive')
    await app.inject({ method: 'DELETE', url: `/api/accounts/${u.wechatId}`, headers: u.hdr() })

    const res = JSON.parse((await app.inject({
      method: 'POST', url: '/api/assets/snapshot', headers: u.hdr(),
    })).payload)

    expect(snapsOf(u.wechatId)).toHaveLength(0)
    expect(res.data.total).toBe(3)
    expect(res.data.created).toBe(3)
  })

  it('5. 跨用户：A 采样碰不到 B 的账户与采样行', async () => {
    const a = await freshUser('snap_cross_a')
    const b = await freshUser('snap_cross_b')

    JSON.parse((await app.inject({
      method: 'POST', url: '/api/assets/snapshot', headers: a.hdr(),
    })).payload)

    // B 的账户一个字节都没动
    expect(row(b.bankId).balance_as_of_txn_id).toBe(0)
    expect(snapsOf(b.bankId)).toHaveLength(0)
    // A 自己的采样行确实写进去了（否则上一条是空洞的）
    expect(snapsOf(a.bankId)).toHaveLength(1)
  })

  it('6. 归属校验在 module 内：混入他人账户时整批拒绝，snapshot 与 baseline 都不写', async () => {
    const a = await freshUser('snap_own_a')
    const b = await freshUser('snap_own_b')
    const uidA = uidOf(a.bankId)
    // 让 A 名下确实有流水，基线推进才有可观测的余地
    await app.inject({
      method: 'POST', url: '/api/transactions', headers: a.hdr(),
      payload: { items: [{ type: 'expense', amount: 700, date: '2099-05-01', description: 'x', account_id: a.bankId }] },
    })
    const maxA = maxTxnOf(uidA)
    expect(maxA).toBeGreaterThan(0)

    // 直接调 module：第一个是 A 的账户，第二个是 B 的账户
    expect(() => recordBalanceSamples(
      getDb(), uidA, new Map<number, number>([[a.bankId, 111], [b.bankId, 999]]),
    )).toThrow(/不属于当前用户/)

    // 整批拒绝 ⇒ 连 A 自己那个合法账户也不能被写过
    expect(snapsOf(a.bankId)).toHaveLength(0)
    expect(row(a.bankId).balance_as_of_txn_id).toBe(0)
    expect(snapsOf(b.bankId)).toHaveLength(0)
    expect(row(b.bankId).balance_as_of_txn_id).toBe(0)
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
