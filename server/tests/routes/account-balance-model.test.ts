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
