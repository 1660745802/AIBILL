# 数据模型

> 本文整合原 DATABASE.md 与 WORKBENCH.md。
> 表结构定义**以代码为准**：`server/src/db/schema.ts`，本文只描述设计意图与注意事项。

---

## 1. 概览

| 项 | 约定 |
|----|------|
| 存储引擎 | SQLite 3（单文件，零运维） |
| 金额存储 | **整数（分）**，¥32.50 = 3250 |
| 时间格式 | ISO 8601 字符串（SQLite 无原生日期类型） |
| 版本管理 | `schema_migrations` 表 + `server/src/db/index.ts` 启动时执行 |
| 查询规范 | 业务查询必须带 `user_id` + `status='confirmed'` + `deleted_at IS NULL`（除回收站/管理员） |
| WAL 模式 | 开启，提升并发读 |
| 外键约束 | `PRAGMA foreign_keys = ON` |

**P0 阶段补强（migration 010）**：所有外键添加 `ON DELETE` 策略（CASCADE / SET NULL）。

### 1.1 数据隔离原则
- 所有业务表带 `user_id`
- 每次查询/写入自动附加 `WHERE user_id = ?`
- **管理员不可跨用户查询任何业务数据**

---

## 2. 核心表（Migration 001）

### 2.1 users / invite_codes
- `users.role`: `admin` / `user`
- `users.is_active`: 0=禁用（仍保留数据，但不可登录）
- `invite_codes.used_count < max_uses` 且 `expires_at` 未过期 才有效

### 2.2 categories
- 默认支出 12 项（餐饮/交通/购物/住房/娱乐/医疗/教育/通讯/日用/服饰/人情/其他）
- 默认收入 7 项（工资/奖金/理财/兼职/退款/其他/其他）
- 注册时事务内为每个新用户自动生成

### 2.3 accounts
- 类型枚举：`cash | wechat | alipay | bank | credit | other`
- **余额不存字段**，实时计算：`initial_balance + income - expense + transfer_in - transfer_out`

### 2.4 transactions（核心）
```
source:       manual | ai | import_csv | app_notification | ocr | subscription
client_type:  web | app_android | app_ios | import_script
status:       confirmed | pending  （pending 不计入统计）
tags:         JSON 数组字符串
ai_raw_input: AI 记账时的原始输入（可追溯）
deleted_at:   软删除标记，30 天后可清理
```

**幂等键**：`UNIQUE(user_id, client_id) WHERE client_id IS NOT NULL`

### 2.5 budgets
- `category_id = 0` 表示总预算（SQLite UNIQUE 对 NULL 不生效，用 0 作哨兵）
- `month = 0` 表示全年预算（period='yearly'）
- `UNIQUE(user_id, category_id, year, month)`

### 2.6 ai_conversations
- `session_id`：UUID，区分不同对话
- `role`：user / assistant / system
- `metadata`：JSON（token 用量、模型名）

### 2.7 settings / user_settings
- `settings` 全局级（admin 管）
- `user_settings` 用户级覆盖（PK = (user_id, key)）
- 读取优先级：`user_settings` > `settings`

---

## 3. P1 新增表

| Migration | 表 | 用途 |
|-----------|----|----|
| 002 | `ai_parse_logs` | AI 解析质量日志（含 user_modified 修正率） |
| 004 | `ai_memories` | AI 全局记忆（preference/habit/rule/context） |
| 005 | `subscriptions` | 订阅管理（cycle + next_payment_date） |
| 006 | `app_logs` | 应用运行日志 |
| 007 | `notification_rules` | 通知记账规则云控（version + ETag 缓存） |
| 008 | `financial_goals` / `goal_progress` / `asset_snapshots` / `recurring_patterns` | 财务工作台 |

### 3.1 accounts 扩展（migration 008）
```
asset_type: liquid(活期) | savings(定期) | investment(理财) | credit(信用卡) | loan(贷款) | property(不动产) | other
currency:   CNY（默认）
credit_limit, due_day, billing_day: 信用卡专用
note:       自由备注
```

### 3.2 ai_memories
```
category: preference | habit | rule | context
source:   manual（用户添加） | ai_suggested（AI 自动）
```
**安全约束**（P0 安全加固）：注入 LLM 时只取 `source='manual'`，防止 AI 自我污染。

### 3.3 subscriptions
- `cycle: monthly | quarterly | yearly`
- `next_payment_date`：scheduler 扫描触发提醒/自动记账
- 索引 `(user_id, status)` + `(user_id, next_payment_date)` — 待 scheduler 全量后扩展 partial index

### 3.4 asset_snapshots
- 月度账户余额快照（`UNIQUE(user_id, account_id, snapshot_date)`）
- 用于生成净资产趋势（无需回溯扫描全量 transactions）

### 3.5 recurring_patterns
- AI 检测或手动标记的固定收支
- `frequency: monthly | weekly | biweekly | quarterly | yearly`
- `confidence: REAL`（AI 检测时 < 1.0）

### 3.6 financial_goals + goal_progress
```
type: saving | debt_payoff | investment | custom
status: active | completed | paused | abandoned
```
- `goal_progress` 自动清理（迁移完成/放弃的目标）

---

## 4. P2 规划表（未实施）

| 表 | 阶段 | 状态 |
|----|------|------|
| `debts` + `debt_payments` | P2c 负债中心 | 📋 |
| `investments` + `investment_transactions` | P3a 投资理财 | 📋 |
| `holdings` + `holding_transactions` | Phase 4 投资追踪 | 📋 |
| `jwt_revocations` | P0 安全加固（migration 009） | ✅ |
| `cashflow_forecasts` | Phase 2 现金流预测 | 📋 |
| `financial_health_scores` | Phase 3 财务健康度 | 📋 |

详细字段定义见 git history（已废弃的 WORKBENCH.md §3-4）。

---

## 5. ER 关系图（精简版）

```
users ─┬─ invite_codes (created_by → SET NULL)
       ├─ categories (UNIQUE user_id+name+type)
       ├─ accounts (UNIQUE user_id+name)
       ├─ transactions ─┬─ categories (→ SET NULL)
       │                ├─ accounts (account_id, SOURCE)
       │                └─ accounts (target_account_id, SOURCE)
       ├─ budgets
       ├─ ai_conversations
       ├─ ai_memories
       ├─ subscriptions ─┬─ categories
       │                └─ accounts
       ├─ financial_goals ── goal_progress (CASCADE)
       ├─ asset_snapshots ── accounts
       ├─ recurring_patterns
       ├─ app_logs
       ├─ notification_rules (created_by)
       └─ jwt_revocations (user_id, CASCADE)
settings (全局) ──── user_settings (PK: user_id+key, CASCADE)
```

---

## 6. 关键查询模式

### 6.1 月度统计
```sql
SELECT type, SUM(amount) AS total_cents
FROM transactions
WHERE user_id = ?
  AND status = 'confirmed'
  AND type IN ('expense', 'income')
  AND date BETWEEN ? AND ?
  AND deleted_at IS NULL
GROUP BY type;
```
**索引**：`idx_transactions_stats (user_id, type, date) WHERE status='confirmed' AND deleted_at IS NULL`

### 6.2 分类排行
```sql
SELECT c.name, c.icon, SUM(t.amount) AS total_cents, COUNT(*) AS cnt
FROM transactions t
JOIN categories c ON t.category_id = c.id
WHERE t.user_id = ? AND t.status = 'confirmed' AND t.type = 'expense'
  AND t.date BETWEEN ? AND ? AND t.deleted_at IS NULL
GROUP BY t.category_id ORDER BY total_cents DESC;
```
**索引**：`idx_transactions_category_stats (user_id, category_id, date) WHERE status='confirmed' AND deleted_at IS NULL AND type='expense'`

### 6.3 账户余额（**单条聚合**，已修复 N+1）
```sql
SELECT
  a.id, a.name,
  a.initial_balance
    + COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0)
    + COALESCE(SUM(CASE WHEN t.type='transfer' AND t.target_account_id=a.id THEN t.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN t.type='transfer' AND t.account_id=a.id THEN t.amount ELSE 0 END), 0)
  AS current_balance_cents
FROM accounts a
LEFT JOIN transactions t ON (t.account_id = a.id OR t.target_account_id = a.id)
  AND t.user_id = a.user_id
  AND t.status = 'confirmed'
  AND t.deleted_at IS NULL
  AND t.date <= ?
WHERE a.user_id = ? AND a.is_active = 1
GROUP BY a.id;
```

### 6.4 预算使用情况
```sql
SELECT b.id, COALESCE(c.name, '总预算') AS category_name,
  b.amount AS budget_cents,
  (SELECT COALESCE(SUM(amount), 0) FROM transactions
   WHERE user_id = b.user_id AND type = 'expense' AND status = 'confirmed'
     AND (b.category_id = 0 OR category_id = b.category_id)
     AND date BETWEEN ? AND ? AND deleted_at IS NULL) AS spent_cents
FROM budgets b
LEFT JOIN categories c ON b.category_id = c.id
WHERE b.user_id = ? AND b.year = ? AND (b.month = ? OR b.month = 0);
```

---

## 7. 索引策略

| 原则 | 说明 |
|------|------|
| 高频查询覆盖 | 复合索引 + partial WHERE 命中常用查询 |
| 列顺序 | 高选择性在前（如 `user_id, type, date`） |
| 单列索引 | 仅在确实需要时建，避免冗余（P0 已清理 4 个冗余单列索引） |
| 命名 | `idx_<表名>_<字段>` |

**已优化索引**（migration 003）：
- `idx_transactions_stats` 覆盖统计/预算/趋势
- `idx_transactions_category_stats` 覆盖 by-category
- `idx_transactions_list` 优化列表排序（`DESC, DESC`）
- `idx_ai_conversations_session_user` 覆盖会话查询

---

## 8. 数据迁移规范

### 8.1 命名
```ts
export const migrationNNN = `...`;  // NNN 三位数字
```

### 8.2 规则
1. **只增不改**：禁止修改已应用的 migration
2. **事务内执行**：每个 migration 包在 `db.transaction()` 中
3. **幂等**：使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
4. **新表**：独立文件 `migrationNNN_<name>.sql` 风格（当前集中于 schema.ts，可后续拆分）
5. **schema 变更**：用 `ALTER TABLE ADD COLUMN`，默认值保证向后兼容
6. **外键策略**：新表必须显式声明 `ON DELETE`（CASCADE / SET NULL）

### 8.3 seed 数据
```sql
INSERT OR IGNORE INTO settings (key, value) VALUES (...);
```
默认分类/账户为**用户注册时事务内生成**（不是全局 seed）。

---

## 9. 当前 migration 清单

| 版本 | 名称 | 内容 |
|------|------|------|
| 001 | initial_schema | users / invite_codes / categories / accounts / **transactions** / budgets / ai_conversations / settings / user_settings |
| 002 | ai_parse_logs | AI 解析质量日志 |
| 003 | stats_indexes | 4 个 partial index |
| 004 | ai_memories | AI 全局记忆 |
| 005 | subscriptions | 订阅管理 |
| 006 | app_logs | 应用运行日志 |
| 007 | notification_rules | 通知规则版本管理 |
| 008 | financial_workstation | 资产快照 + 目标 + 周期模式 + accounts 扩展 |
| **009** | **jwt_revocations** | JWT jti 黑名单（P0 安全加固） |
| **010** | **fk_on_delete** | 所有外键补 ON DELETE 策略（P0 安全加固） |
| **011** | **drop_redundant_indexes** | 删除 4 个冗余单列索引（P0 性能加固） |