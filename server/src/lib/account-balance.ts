/**
 * 账户余额的**唯一**口径。
 *
 * 模型（用户定义的）：
 *   - 余额是一个存着的数（`accounts.balance`），不是每次重算
 *   - 有归属的账单增删改 → 增量加减这个数
 *   - 手填 → 覆盖这个数，并刷新基准线 `accounts.balance_as_of_txn_id`
 *
 * 两个入口，两种**语义**，都在本文件内（不再有路由自己写 SQL 的旁路）：
 *   | 入口 | 函数 | 语义 |
 *   |---|---|---|
 *   | 账单增删改 | `applyTxn` | 增量 |
 *   | 用户手填（账户 PUT / 资产快照 PUT） | `setManualBalance` | 覆盖 + 推进基线 |
 *
 * 手填同时写快照凭证行（`asset_snapshots`），upsert 覆盖。
 *
 * 曾存在的第三条——旧客户端 `POST /assets/snapshot` 的「采样 + **仅首次**推进基线」
 * （`recordBalanceSamples`）——已随那个 deprecated 端点一起删除：
 * 核查确认它从未被任何客户端调用过（web 不用，Android 全history 无引用）。
 * 保留它只会留下一条无人可达的分支，而它的存在正是「余额口径有三条路」的根源。
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

// 「今天」的唯一口径：北京时间（见 lib/date.ts）。全仓不再散写 toISOString()。
import { today } from './date.js'

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
 * 「今天」= **北京时间**（`lib/date.ts` 的 `today()`，见文件头 import），全仓唯一口径。
 *
 * 抽出来是因为两个写入函数都要用它，且**调用方必须拿到同一个值**：
 * 响应里的 `date` 和写进快照行的 `snapshot_date` 一旦分叉，
 * 「今日快照已存在」这句话就会对不上用户看到的日期。
 *
 * > **D2 已决**：原先用 SQLite 的 `date('now')`（UTC），与 `lib/date.ts`、
 * > `scheduler.beijingDate()` 三套并存。北京 00:00–08:00 指向不同日期，
 * > 深夜记账会把快照记到前一天。现已统一为北京时间。
 * > 快照日期语义**确实变了**：历史 `snapshot_date` 不动，新数据在北京时间
 * > 00:00–08:00 之间落在「当天」而不是「昨天」。曲线翻页时刻随之对齐。
 */

/**
 * 手填余额 = **覆盖**，并把基准线刷到此刻。
 *
 * 两条路径（账户 PUT / 资产快照 PUT）走这里。
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

/**
 * 手填余额被拒的原因（D3）。
 *
 * 用**类型化错误**而不是字符串：调用方要把它翻成合适的 HTTP 响应，
 * 而字符串匹配会在改文案时静默失效——之前就是抛裸 Error，一路穿透成 500，
 * 「停用账户不能写」会变成「服务器错误」，用户完全看不懂。
 */
export type BalanceWriteRejection = 'not_owned' | 'inactive'

export class BalanceWriteRejected extends Error {
  constructor(
    readonly reason: BalanceWriteRejection,
    readonly accountId: number,
  ) {
    super(
      reason === 'not_owned'
        ? `账户 ${accountId} 不存在或不属于当前用户`
        : `账户 ${accountId} 已停用，不能修改余额`,
    )
    this.name = 'BalanceWriteRejected'
  }
}

/**
 * 手填余额 = **覆盖**，并把基准线刷到此刻。
 *
 * 两条路径（账户 PUT / 资产快照 PUT）走这里。
 *
 * 同时写一行 `asset_snapshots` 作为历史/回滚凭证：用 upsert，
 * 同一天反复填不会撞 UNIQUE(user_id, account_id, snapshot_date)。
 *
 * ## 停用账户不写（D3）
 *
 * `is_active = 0` 的账户**拒绝**手填余额。这不是洁癖：
 * 所有读模型（`readAccounts` / `readHistory` / `countAccounts`）都过滤
 * `is_active = 1`，给它写余额等于「写进一个不被读的地方」——快照行进库了，
 * 而净资产、曲线、构成全都看不到它，用户却以为记上了；而且基准线被推进了，
 * 将来恢复该账户时，那之间的账单加减会被静默跳过。
 *
 * 修之前两条入口口径还相反：`PUT /assets/snapshots` 已拒（守卫带 `is_active`），
 * `PUT /api/accounts/:id` 却照写。现由本函数统一，两条路径同生共死。
 */
export function setManualBalance(
  db: any,
  userId: number,
  accountId: number,
  value: number,
  opts?: { date?: string },
): void {
  const date = opts?.date ?? today()

  const run = db.transaction(() => {
    const owned = db
      .prepare('SELECT id, is_active FROM accounts WHERE id = ? AND user_id = ?')
      .get(accountId, userId) as { id: number; is_active: number } | undefined
    if (!owned) throw new BalanceWriteRejected('not_owned', accountId)
    // 停用账户不可写（见函数头「停用账户不写」）
    if (owned.is_active !== 1) throw new BalanceWriteRejected('inactive', accountId)

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
