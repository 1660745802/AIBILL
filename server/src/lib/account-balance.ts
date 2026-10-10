/**
 * 账户余额的**唯一**口径。
 *
 * 模型（用户定义的）：
 *   - 余额是一个存着的数（`accounts.balance`），不是每次重算
 *   - 有归属的账单增删改 → 增量加减这个数
 *   - 手填 → 覆盖这个数，并刷新基准线 `accounts.balance_as_of_txn_id`
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
 * @param userId 账户归属校验：只允许改**当前用户自己**账户的余额
 *
 * @returns 每个账户是否真的应用了（被基准线挡掉的会是 false）
 */
export function applyTxn(
  db: any,
  tx: any,
  sign: 1 | -1,
  userId?: number,
): Array<{ accountId: number; applied: boolean }> {
  const out: Array<{ accountId: number; applied: boolean }> = []
  const txnId = Number(tx.id)
  for (const [accountId, delta] of deltasFor(tx)) {
    // 归属校验：不带 user_id 就没有这层保护，任何人都能改别人的余额
    const row = userId == null
      ? db.prepare('SELECT balance, balance_as_of_txn_id FROM accounts WHERE id = ?').get(accountId)
      : db.prepare('SELECT balance, balance_as_of_txn_id FROM accounts WHERE id = ? AND user_id = ?')
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
 * 手填余额 = **覆盖**，并把基准线刷到此刻。
 *
 * 三条路径（账户 PUT / 资产快照 PUT / 旧客户端 snapshot POST）全部走这里，
 * 避免同一语义三份实现——之前其中一份是坏的（同 UNIQUE 冲突即 500）。
 *
 * 同时写一行 `asset_snapshots` 作为历史/回滚凭证：用 upsert，
 * 同一天反复填不会撞 UNIQUE(user_id, account_id, snapshot_date)。
 */
export function setManualBalance(
  db: any,
  userId: number,
  accountId: number,
  value: number,
  opts?: { date?: string },
): void {
  const today = (db.prepare(`SELECT date('now') d`).get() as { d: string }).d
  const date = opts?.date ?? today

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
}
