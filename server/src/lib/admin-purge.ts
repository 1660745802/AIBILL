/**
 * 删除用户时的数据清除（C1 拆出的 module）
 *
 * 三件事被收进**同一个 module 的性质**（而不是散在 `routes/admin.ts` 的 handler 里）：
 *   ① **要清哪些表**：15 张 user 维度表的清单；
 *   ② **以什么顺序清**：`admin_unparsed_triage` 先于 `ai_parse_logs` / `users`，且父表
 *      `categories` / `accounts` **最后**；
 *   ③ **哪些只置空不删**：`invite_codes` / `notification_rules` 是全局资源，
 *      `created_by` 置 NULL 而不是删行。
 *
 * 为什么「顺序」必须是 module 自身的性质：`PRAGMA foreign_keys = ON` 下先删父表会抛
 * `SQLITE_CONSTRAINT_FOREIGNKEY`，而 `defer_foreign_keys` 救不了——它只是把检查推迟到
 * 提交，子行依然存在。所以唯一正确的解法就是删除顺序，它不该依赖调用方的自觉。
 *
 * 新增带 `user_id` 外键的表时，务必按依赖关系插进清单的正确位置（`routes/admin/users.ts`
 * 的删除分支有一条兜底断言：新表外键没被清掉时删除会先失败，而不是静默留孤儿行）。
 */
import type { getDb } from '../db/index.js'

type Db = ReturnType<typeof getDb>

/**
 * 删除用户时需要清理的表（顺序 = 依赖倒序：先子表，后父表）
 *
 * 背景：PRAGMA foreign_keys = ON，子表被父表引用时若先删父表会抛
 * SQLITE_CONSTRAINT_FOREIGNKEY。defer_foreign_keys 也救不了——它只是把检查
 * 推迟到提交，子行依然存在。因此**唯一正确的解法是删除顺序**。
 *
 * 新增带外键的表时，务必按依赖关系插入到正确位置。
 */
export const USER_SCOPED_TABLES: string[] = [
  'asset_snapshots',      // → accounts
  'recurring_patterns',   // → categories / accounts
  'subscriptions',        // → categories / accounts
  'financial_goals',      // → accounts（goal_progress 由 ON DELETE CASCADE 连带清除）
  'investments',          // → accounts（漏了会 DELETE accounts 抛外键约束 → 有持仓的用户删不掉）
  'transactions',         // → categories / accounts
  'client_capture_samples', // → users（ON DELETE CASCADE）；漏了会因外键删不掉用户
  'ai_conversations',
  'ai_parse_logs',
  'ai_parse_filters',     // 无外键，但同样是 user 维度数据（漏了会留下永久孤儿行）
  'ai_memories',
  'budgets',              // → categories
  'user_settings',
  'categories',           // 父表：最后删
  'accounts',             // 父表：最后删
]

/**
 * 清除某个用户的全部业务数据（不含 users 行本身），调用方需自行控制事务。
 * @param userId 目标用户 id
 */
export function purgeUserData(db: Db, userId: number): void {
  /* 人工裁决记录（migration 023）：既可能挂在目标用户的解析行上（`parse_log_id → ai_parse_logs`），
     也可能是目标用户作为 admin 留下的（`admin_id → users`）。必须在删 `ai_parse_logs` / `users`
     **之前**清，否则外键约束会让「有裁决记录的用户」删不掉。 */
  db.prepare(
    `DELETE FROM admin_unparsed_triage
      WHERE parse_log_id IN (SELECT id FROM ai_parse_logs WHERE user_id = ?)
         OR admin_id = ?`,
  ).run(userId, userId)

  for (const table of USER_SCOPED_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
  }

  // 引用 users(id) 但列可空的表：置空而不是删行
  // （邀请码 / 规则版本是全局资源，不应随创建者消失）
  db.prepare('UPDATE invite_codes SET created_by = NULL WHERE created_by = ?').run(userId)
  db.prepare('UPDATE notification_rules SET created_by = NULL WHERE created_by = ?').run(userId)
}
