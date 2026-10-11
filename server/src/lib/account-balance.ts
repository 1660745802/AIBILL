/**
 * 账户余额的**唯一**口径。
 *
 * 模型（用户定义的）：
 *   - 余额是一个存着的数（`accounts.balance`），不是每次重算
 *   - 有归属的账单增删改 → 增量加减这个数
 *   - 手填 → 覆盖这个数，并刷新基准线 `accounts.balance_as_of_txn_id`
 *
 * 三个入口，两条**语义**，都在本文件内（不再有路由自己写 SQL 的旁路）：
 *   | 入口 | 函数 | 语义 |
 *   |---|---|---|
 *   | 账单增删改 | `applyTxn` | 增量 |
 *   | 用户手填（账户 PUT / 资产快照 PUT） | `setManualBalance` | 覆盖 + 推进基线 |
 *   | 旧客户端 `POST /assets/snapshot` | `recordBalanceSamples` | 采样 + **仅首次**推进基线 |
 *
 * 后两者都写快照凭证行，区别在**冲突策略**与**基线是否前进**——见各自的注释。
 *
 * 不变量：
 *   balance == 上次手填的值 + **基准线之后新建**的有归属流水的增减
 *
 * ## 基准线为什么用「事务 id」而不是日期/时间戳
 *
 * 试过两种更直观的方式，都会错：
 *
 * 1. **日期 + `<=`**：手填当天下午记的账单（业务日期就是今天）因为 `今天 <= 今天`
 *    被判成「已烤进手填值里」而永久跳过——直接推翻了用户说的
 *    「我改了余额，后续有新账单余额跟着变」。资产页「记录今日」通常在早上，更糟。
 * 2. **`created_at` 时间戳**：同一天/同一秒内手填和新建无法区分，
 *    无论用 `<` 还是 `<=` 都有一边错。
 *
 * `transactions.id` 是自增主键，单调且没有精度问题：
 *   - 手填时把当前 `MAX(id)` 记进 `balance_as_of_txn_id`
 *   - 只有 `id > balance_as_of_txn_id` 的账单才参与加减
 *
 * 于是「手填之前存在的」与「手填之后新建的」被精确切开，
 * 与业务日期无关（补录昨天的账也会正常影响当前余额）。
 *
 * ## `balance_as_of_txn_id = 0` 的含义
 *
 * 没有手填过 ⇒ `balance` 仍然等于「期初余额 + 全部有归属流水」，
 * 所以**所有**流水都参与加减。migration 017 负责在迁移时把这个值算出来。
 */

/**
 * 一笔流水对各账户余额的增减。没有 `account_id` 的返回空数组——
 * **没归属就不动账户**（旧客户端行为不变）。
 */
export function deltasFor(tx: any): Array<[accountId: number, delta: number]> {
  const status = tx.status == null ? 'confirmed' : String(tx.status)
  if (status !== 'confirmed') return []
  const type = String(tx.type ?? '')
  const amt = Number(tx.amount) || 0
  if (!amt) return []
  const srcId = toId(tx.account_id)
  const dstId = toId(tx.target_account_id)

  // 自转账（同一个账户转给自己）净影响为 0，两边都不记。
  // 旧的重算 SQL 两条 CASE 命中同一行会互相抵消，这里显式跳过更清楚。
  if (type === 'transfer' && srcId != null && srcId === dstId) return []

  const out: Array<[number, number]> = []
  if (srcId != null) {
    out.push([srcId, type === 'expense' || type === 'transfer' ? -amt : amt])
  }
  if (type === 'transfer' && dstId != null) {
    out.push([dstId, amt])
  }
  return out
}

function toId(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 把一笔流水的增减应用到账户余额上。
 *
 * @param sign +1 应用（新建/恢复）、-1 撤销（删除）；编辑时先 -1 旧再 +1 新
 * @param userId **必填**：账户归属校验，只允许改**当前用户自己**账户的余额
 *
 * @returns 每个账户是否真的应用了（被基准线挡掉的会是 false）
 */
export function applyTxn(
  db: any,
  tx: any,
  sign: 1 | -1,
  userId: number,
): Array<{ accountId: number; applied: boolean }> {
  const out: Array<{ accountId: number; applied: boolean }> = []
  const txnId = Number(tx.id)
  for (const [accountId, delta] of deltasFor(tx)) {
    // 归属校验。之前 userId 是可选的，少传就退化成「不校验」——等于给
    // 跨用户改余额留了一条合法路径（PUT /transactions/:id 曾真的出过这个事）。
    // 现在必填：想写别人余额的代码必须先拿到 userId，拿不到就编译不过。
    const row = db
      .prepare('SELECT balance, balance_as_of_txn_id FROM accounts WHERE id = ? AND user_id = ?')
      .get(accountId, userId)
    if (!row) continue

    // 基准线之前就已存在的账单不再影响余额（否则就是重复扣减）
    const asOfId = row.balance_as_of_txn_id == null ? 0 : Number(row.balance_as_of_txn_id)
    if (Number.isFinite(txnId) && txnId <= asOfId) {
      out.push({ accountId, applied: false })
      continue
    }
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(delta * sign, accountId)
    out.push({ accountId, applied: true })
  }
  return out
}

/**
 * 「今天」。口径与改动前逐字相同（SQLite 的 `date('now')`，即 UTC）——
 * 本文件只做 seam 收口，不动时区语义。
 *
 * 抽出来是因为两个写入函数都要用它，且**调用方必须拿到同一个值**：
 * 响应里的 `date` 和写进快照行的 `snapshot_date` 一旦分叉，
 * 「今日快照已存在」这句话就会对不上用户看到的日期。
 *
 * > **deferred**：全仓另有 `lib/date.ts`（本地时区）与 `scheduler.beijingDate()`
 * > （北京时间），本函数用的是第三种（UTC）。北京 00:00–08:00 之间三者会差一天，
 * > 而窗口每天有 8 小时。收口「今天」的定义会同时改写读模型曲线的翻页时刻，
 * > 与净资产读模型的改动必须同批做，故**本次明确推迟**，不在 seam 收口里夹带。
 */
function todayStr(db: any): string {
  return (db.prepare(`SELECT date('now') d`).get() as { d: string }).d
}

/**
 * 手填余额 = **覆盖**，并把基准线刷到此刻。
 *
 * 两条路径（账户 PUT / 资产快照 PUT）走这里。旧客户端的 `POST /assets/snapshot`
 * **不走这里**——它的语义不同，见 `recordBalanceSamples`。之前这个文件写着
 * 「三条路径全部走这里」，而第三条实际是在路由里直接写 SQL 推进基线的。
 *
 * 同时写一行 `asset_snapshots` 作为历史/回滚凭证：用 upsert，
 * 同一天反复填不会撞 UNIQUE(user_id, account_id, snapshot_date)。
 *
 * ## 为什么自己包事务
 *
 * 「余额覆盖」和「快照凭证」是同一件事的两半：只落一半就等于留下一条
 * 没有凭证的余额（或者一条与余额对不上的凭证）。以前这个函数**不带**事务，
 * 靠调用点包——于是 `PUT /api/accounts/:id` 里它在最前面跑，
 * 后面改名字撞 UNIQUE 失败时，余额已经改了、快照也写了，客户端只拿到 500。
 *
 * 自己包事务后：独立调用时它自己成事务；被外层 `db.transaction` 包住时
 * 自动退化成 SAVEPOINT，随外层一起提交/回滚（better-sqlite3 的嵌套语义）。
 *
 * ### 那它现在到底多做了什么？
 *
 * 诚实地说：**当前两个调用点都已经有外层事务**，所以此刻这个内部事务
 * 并不比之前多保任何东西——
 *
 * | 调用点 | 外层事务 |
 * |---|---|
 * | `PUT /api/accounts/:id` | 有（整个 handler 包在一个 `db.transaction` 里） |
 * | `PUT /api/assets/snapshots` | 有（循环被 `db.transaction` 包住） |
 *
 * 它的价值是给**独立调用与未来的调用点**兜底：
 *  - 独立调用时，不会出现「余额改了、快照没写」的半状态；
 *  - 下一个调用点若忘了包事务，也不会重蹈 `PUT /api/accounts/:id`
 *    曾经「靠调用点包」而漏包的覆辙——这类漏包只有出故障时才暴露。
 *
 * 换句话说：这是把正确性从「每个调用点的纪律」变成「module 自身的性质」。
 * 代价只是嵌套时多一层 SAVEPOINT，better-sqlite3 原生支持，无需调用点配合。
 */
export function setManualBalance(
  db: any,
  userId: number,
  accountId: number,
  value: number,
  opts?: { date?: string },
): void {
  const date = opts?.date ?? todayStr(db)

  const run = db.transaction(() => {
    const owned = db
      .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
      .get(accountId, userId)
    if (!owned) throw new Error(`账户 ${accountId} 不存在或不属于当前用户`)

    // 基准线 = 此刻已存在的最大流水 id。之后新建的才参与加减。
    const maxId = (db
      .prepare('SELECT COALESCE(MAX(id), 0) m FROM transactions WHERE user_id = ?')
      .get(userId) as { m: number }).m

    db.prepare('UPDATE accounts SET balance = ?, balance_as_of_txn_id = ? WHERE id = ? AND user_id = ?')
      .run(value, maxId, accountId, userId)

    db.prepare(
      `INSERT INTO asset_snapshots (user_id, account_id, balance, snapshot_date, source)
       VALUES (?, ?, ?, ?, 'manual')
       ON CONFLICT(user_id, account_id, snapshot_date)
         DO UPDATE SET balance = excluded.balance`,
    ).run(userId, accountId, value, date)
  })
  run()
}

export interface BalanceSampleResult {
  /** 本次采样记在哪一天（响应与快照行共用同一个值） */
  date: string
  /** 真的插进去一行 = 今天第一次记这个账户 */
  created: number
  /** 今天已经有行了，什么都没做 */
  skipped: number
  /** 本次考虑了几个账户 */
  total: number
}

/**
 * 旧客户端 `POST /api/assets/snapshot` 的写入实现。
 *
 * ## 它和 `setManualBalance` 不是一回事（不要合并）
 *
 * 两者写的表一样、推的基线一样，但**用户意图不同**，合并会改变行为：
 *
 * | | `setManualBalance`（手填） | 本函数（采样） |
 * |---|---|---|
 * | `accounts.balance` | **覆盖**成用户填的数 | **不写**，只把当前权威值记进快照行 |
 * | 同一天重复 | upsert **覆盖** | `ON CONFLICT(user_id, account_id, snapshot_date) DO NOTHING` **跳过** |
 * | 推进基线 | 无条件 | **只有真插进去才推进** |
 *
 * 最后一行是全部要害：若这里也无条件推进，那么「今天第二次点快照」会把
 * 两次之间新建的账单烤进余额，此后 `applyTxn` 对它们的修正会被基准线挡掉
 * （`txnId <= balance_as_of_txn_id`）——用户改一笔旧账，余额纹丝不动，
 * 且没有任何提示。所以那个「唯一键冲突就跳过」不是偷懒，是语义。
 *
 * 用的是点名冲突目标的 `ON CONFLICT(user_id, account_id, snapshot_date) DO NOTHING`，
 * 而不是 `INSERT OR IGNORE`：后者会把 CHECK / FK / NOT NULL 一并忽略掉，
 * 那些是 bug，不该伪装成「今天已经有了」。
 *
 * ## 谁决定「哪些账户」
 *
 * 调用方先按自己的口径筛好（legacy 端点排除理财账户与停用账户），
 * 把「账户 → 要记的余额」整包交进来：写入、推进、计数、事务全在本函数内，
 * 调用方不可能只做一半。计数也从这里出，调用方不再自己数 `changes`。
 *
 * ## 归属校验在这里，不只在调用方
 *
 * 调用方已经按 `user_id` 筛过一遍，但本函数是 deep module，不能假设调用方
 * 永远记得筛：写入前先把所有 accountId 过一遍归属，**有一个不是本人的就整批拒绝**。
 * 拒绝发生在任何写入之前，且包在事务里 ⇒ snapshot 与 baseline 一个字节都不动。
 *
 * ## 事务边界
 *
 * 自己包事务，因此**独立调用也保证原子性**（整批采样要么全成、要么全不成）。
 *
 * 当前唯一的调用点（`POST /api/assets/snapshot`）已经把整批循环包在
 * `db.transaction` 里，所以此刻这个内部事务并不比之前多保什么；它的价值是
 * **独立调用与未来调用点**：下一个调用点即便忘了包事务也不会半途而废，
 * 被外层包住时则退化成 SAVEPOINT 随外层一起提交/回滚（better-sqlite3 的嵌套语义）。
 */
export function recordBalanceSamples(
  db: any,
  userId: number,
  balances: ReadonlyMap<number, number>,
  opts?: { date?: string },
): BalanceSampleResult {
  const date = opts?.date ?? todayStr(db)

  // 只对「唯一键冲突」跳过，不吞掉其余完整性错误。
  // `INSERT OR IGNORE` 会把 CHECK / FK / NOT NULL 一并忽略掉——那些是 bug，
  // 不该伪装成「今天已经有了」。这里点名那一条 UNIQUE(user_id, account_id, snapshot_date)。
  const insertSample = db.prepare(
    `INSERT INTO asset_snapshots (user_id, account_id, balance, snapshot_date, source)
     VALUES (?, ?, ?, ?, 'manual')
     ON CONFLICT(user_id, account_id, snapshot_date) DO NOTHING`
  )
  // 归属校验用的预编译语句：先做完校验再开始写。
  const ownedAccount = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
  // 基准线只前进、不倒退，且永远只动**自己**的账户。
  const advanceBaseline = db.prepare(
    `UPDATE accounts SET balance_as_of_txn_id =
       (SELECT COALESCE(MAX(id), 0) FROM transactions WHERE user_id = ?)
     WHERE id = ? AND user_id = ?`
  )

  const run = db.transaction(() => {
    // 先校验、后写入：任何一个 accountId 不属于本用户就抛，整批不落任何东西。
    for (const accountId of balances.keys()) {
      if (!ownedAccount.get(accountId, userId)) {
        throw new Error(`账户 ${accountId} 不存在或不属于当前用户`)
      }
    }

    let created = 0
    let skipped = 0
    for (const [accountId, balance] of balances) {
      const result = insertSample.run(userId, accountId, balance, date)
      if (result.changes > 0) {
        created++
        advanceBaseline.run(userId, accountId, userId)
      } else {
        skipped++
      }
    }
    return { date, created, skipped, total: balances.size }
  })
  return run()
}
