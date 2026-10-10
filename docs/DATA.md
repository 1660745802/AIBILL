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
| 012 | `ai_parse_filters` (+ `transactions.parse_log_id`) | 预筛记录 / 落地追踪（详见 §10.4） |
| 013 | `asset_snapshots.quantity` / `.total_invested` | 资产快照支持份额与账户级净投入（详见 §10.1） |
| 014 | `investments` / `investment_quotes` | 按标的持仓 + 行情历史（详见 §10.2 / §10.3） |
| 015 | `ai_parse_filters`（幂等补建） | 修生产库缺表（详见 §10.4） |
| 016 | 删 `investments.cost_basis`、`asset_snapshots.quantity`/`.total_invested`；加 `accounts.invested_total` | 单只不再记成本；总投入搬到账户（详见 §10.5） |

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
| `investments` + `investment_quotes` | 投资理财（migration 014） | ✅ 见 §10.2 / §10.3 |
| `holdings` + `holding_transactions` | Phase 4 投资追踪（早期命名，实际落地为 `investments`） | 📋 |
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
       ├─ investments ── accounts (UNIQUE user_id+account_id+code)
       ├─ ai_parse_filters (预筛记录；无 FK，按 user_id 隔离)
       ├─ recurring_patterns
       ├─ app_logs
       ├─ notification_rules (created_by)
       └─ (users.token_version：JWT O(1) 撤销，无独立表)
investment_quotes (全局行情，按 code 共享，无 user_id)
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
| **009** | **jwt_token_version** | `users.token_version`，JWT O(1) 撤销（P0 安全加固） |
| **010** | **cleanup_redundant_indexes** | 删 4 个冗余单列索引 + 加 subscriptions partial index |
| **011** | **app_updates** | App 自托管更新表（APK 版本分发） |
| **012** | **parse_filter_and_landing**（生产库旧名 `parse_landing_tracking`） | `transactions.parse_log_id` + 新建 `ai_parse_filters` 表（预筛记录） |
| **013** | **asset_snapshot_position** | `asset_snapshots` 加 `quantity` / `total_invested` + `(user_id, snapshot_date DESC)` 索引 |
| **014** | **investments_and_quotes** | 新建 `investments`（持仓）+ `investment_quotes`（行情历史） |
| **015** | **ai_parse_filters_backfill** | 幂等补建 `ai_parse_filters`（修生产库缺表，见下 §10） |
| **016** | **drop_holding_cost_basis** | 删三列冗余/误导性字段 + 加 `accounts.invested_total`（见下 §10.5） |
| **017** | **account_balance_single_source** | 账户余额归一：加 `accounts.balance` / `balance_as_of_txn_id`（见下 §12） |

> ⚠️ migration 012 曾被原地改写：早期版本重建过 `ai_parse_logs`（放宽 `status` CHECK 加 `filtered`），
> 并被误应用到**生产库**（记录名 `parse_landing_tracking`）。当前代码里 012 是「新建 `ai_parse_filters`」版，
> 但生产库里 012 已标 applied 不会重跑 ⇒ `ai_parse_filters` 在生产库缺失。migration 015 幂等补建这张表。

---

## 10. 资产工作台数据模型（migration 012–016）

> 这块是「证券/资产工作台」的存储层。核心原则：**资产数据不从流水回算**——
> 线上 551/553 笔交易没有 `account_id`，回算余额必然错，所以一切走手动快照 + 持仓估值。

### 10.1 asset_snapshots（只记现金）

```
asset_snapshots (account_id, snapshot_date, balance, source)
```

**`balance` = 该账户的现金余额。** 理财账户的持仓市值不在这里，由 `investments` + 行情算。

- 每日采样，`UNIQUE(user_id, account_id, snapshot_date)` + UPSERT → **漏几天随时补**
- 停用账户（软删）的快照不参与读模型（`readSnapshots` 里 `a.is_active = 1`）——
  否则它最后一笔现金永远留在净资产里，还会让「日变动」因覆盖数永不相等而恒为 null

**口径（`lib/portfolio.ts` 守住，均有测试）**：
- **账户总价值 = 持仓市值 + 现金**（用户原话：「股数×单价 + 余额」）
- 无持仓账户：总价值 = 现金
- 行情缺失：账户总价值 `null`；**该账户的现金仍计入净资产**，但整体标 `netWorthComplete=false`
  → UI 显示「≥¥X（N 个账户待取价）」，不把下界当精确值
- 有总投入但没配持仓 → `holdingsPending=true`，浮盈 `null`（未配置 ≠ 亏损）
- 净值曲线拆「持仓市值 / 现金」两条

> **migration 013 加过 `quantity` / `total_invested`，016 又删了。**
> 原因：份额按标的记在 `investments.quantity`；总投入是**账户属性**（只在存/取钱时变，
> 不是每日读数），搬到 `accounts.invested_total`。留在快照里会导致
> 「改一次总投入得伪造一条带日期的快照」，而且同一份数据有两个写入口。

### 10.2 investments（migration 014，持仓，低频手填）

```
id, user_id, account_id,
code            规范化代码：sh518880 / sz159937 / hf_xau
name, market    sh | sz | hk | us | hf
kind            etf | stock | fund | gold_gram（默认 etf）
quantity        REAL   份额/股数；gold_gram 为克数
note, is_active, created_at, updated_at
UNIQUE(user_id, account_id, code)
```

- **单只不记成本、不算盈亏**（用户要求「投入不要针对单只持仓股，计算总投入就可以」）：
  只有 代码 / 名称 / 股数，市值 = 股数 × 现价。盈亏只在账户级出一个数。
  migration 016 删掉了 `cost_basis`——留着它就会有人去算单只盈亏，
  而单只浮盈与账户级浮盈天然不同（后者含现金），同屏显示就会符号打架。
- **成本价是派生的、不存**：`costPrice = cost_basis ÷ quantity`。所以收盘后改股数，成本价自动重算，
  不存在「改了股数忘了更新成本」的脏状态（`lib/holdings.ts`，有测试锁住）。

### 10.3 investment_quotes（migration 014，行情，高频系统抓）

```
id, code, name,
price       REAL   现价
prev_close, change_rate
quote_date  TEXT   行情自带日期（非交易日停在上一交易日）
quoted_at   TEXT   行情自带时间戳
source      默认 'tencent'
created_at
UNIQUE(code, quote_date, quoted_at)   同一时刻重复抓取直接忽略
```

- 估值由 `investments × investment_quotes` 实时算出，**不再手填市值**。
- 保留 `quote_date`（行情自带）与 `created_at`（抓取时刻）两列：非交易日跑定时任务时两者不同，
  用 `quote_date` 当快照日期天然去重，不会造出「今天价格很新鲜」的假象。
- 失败**不写**任何行情（写一条错价比不写更危险），只记日志等下次重试。

### 10.4 ai_parse_filters（migration 012 新建 / 015 补建）

「这次没调用模型」是一个独立事件，单独记一张表，不去污染 `ai_parse_logs.status`
（线上 1419 条日志里 759 条即 53% 是被规则挡下的纯噪声，混进去「空结果率」就废了）。

```
id, user_id, raw_input, cleaned_input,
stage        inbound（调模型前挡下）| outbound（模型给了结果后判定为噪声）
tier         INTEGER  classifyNotification 档位：0=命中噪声 … 4=无任何信号
reasons      TEXT     JSON 数组
duration_ms  INTEGER  判定耗时（分流是纯字符串匹配，应 <1ms）
created_at
索引：(user_id) / (stage) / (created_at)
```

> **为什么有 migration 015**：012 被改写过，生产库里记的是「重建 ai_parse_logs」的旧版，
> 这张 `ai_parse_filters` 从未在生产库落地；012 已标 applied 不会重跑。015 用全 `IF NOT EXISTS`
> 幂等补建此表 + 三个索引，**不动** 012 历史、不重建任何已有表、不改 `schema_migrations` 既有记录。
> 已对生产库只读快照实跑验证：幂等、列结构与索引均正确。

### 10.5 投资列归属整理（migration 016）

```
accounts.invested_total   INTEGER  账户级总投入（分），仅理财账户用。只在存/取钱时改
-- 删除：
investments.cost_basis           单只成本（单只不再算盈亏）
asset_snapshots.quantity         份额已按标的记在 investments
asset_snapshots.total_invested   总投入搬到 accounts
```

- **为什么总投入是账户属性**：它只在存/取钱时变，不是每日读数。放快照里会导致
  「改一次总投入得伪造一条带日期的快照」；而且同一份数据出现两个写入口。
- **为什么单只成本必须删**：留着它就会有人算单只盈亏。单只浮盈（市值 − 单只成本）
  与账户级浮盈（总价值 − 总投入，含现金）天然不同，同屏显示必然符号打架 ——
  这个问题真实出现过：头条「浮动盈亏 +14,170」vs 同一只持仓行「−13,830」。
- **安全前提**：三列在应用时都没有真实数据（`investments` 的 `is_active=1` 为 0 行、
  `asset_snapshots` 为 0 行）；无索引/视图/触发器依赖；`DROP COLUMN` 在事务里，
  中途失败整体回滚（已在生产库副本上实测）。写入路径见 §10.6。

### 10.6 唯一写入路径（避免同一列被两个语义写）

| 数据 | 谁写 | 接口 |
|---|---|---|
| 现金 | `accounts.balance`（017 起唯一真源）：有归属账单实时加减 + 手填覆盖 | `PUT /api/assets/snapshots` |
| 份额 | 用户手填（低频，加/减仓） | `POST/PATCH /api/investments` |
| 总投入 | 用户手填（只在存/取钱时） | `PUT /api/assets/accounts/:id` |
| 行情 | **定时任务**，每 15 分钟检查一次（`QUOTE_REFRESH_MINUTES` 可调），**按市场分别判断时段** | 无接口，`scheduler.ts` 写入 |

> ⚠️ `POST /api/assets/snapshot`（旧口径：按「期初余额 + 流水」回算）**跳过理财账户**。
> 它写的是同一个 `balance` 列，但对理财账户回算出来是「总价值」语义（含持仓），
> 写进去就是「持仓 + 已含持仓的余额」双重计算。该端点为已发布的 Android 客户端保留，故不删，只排除理财账户。
>
> ⚠️ 行情抓取**必须挂在 `runScheduledTasks` 里**。曾经 `processQuoteFetch` 写好了却没有调用者，
> 结果是 `investment_quotes` 永远 0 行、持仓永远「未取到价」、账户总价值永远算不出。
> 回归测试见 `tests/lib/scheduler-quotes.test.ts`。

## 11. 行情抓取时段（按市场）

A股 / 港股 / 美股 的开市时间**完全不同**，所以门禁必须按市场算——
只判断「是不是 A 股盘中」会让港股收盘价和美股永远抓不到。

| 市场 | 当地 | **北京时间** | 代码前缀 |
|---|---|---|---|
| A股 | 9:30-11:30 / 13:00-15:00 | 同左 | `sh` `sz` `bj` |
| 港股 | 9:30-12:00 / 13:00-16:00 | 同左（**比 A 股晚 1 小时收盘**） | `hk` |
| 美股 | 9:30-16:00 ET | **21:30-04:00**（夏令时）/ 22:30-05:00（冬令时） | `us` `hf_` |

实测各时刻是否抓（北京）：

```
北京     A股    港股    美股
10:00    ✅     ✅      —
15:20    ✅     ✅      —      ← A股收盘捕获；港股还在交易
16:20     —     ✅      —      ← 港股收盘捕获
22:00     —      —     ✅      ← 美股盘中
02:00     —      —     ✅
```

美股跨午夜，窗口用「21:25 到次日 05:40」的宽窗口覆盖夏令时/冬令时；
多抓的那段拿到的是上一交易日收盘价，有 `UNIQUE(code, quote_date, quoted_at)`
去重，不会写脏数据。

### 两个必须注意的坑

**① 时区**：判断必须用**北京时间**，不能用 `now.getHours()`。
容器通常跑在 UTC，用本地时间会让门禁整体错 8 小时——北京盘中（UTC 02:00）
被判成「非交易时段」，北京夜里反而去抓。`beijingNow()` / `beijingDate()`
负责换算，中国不实行夏令时所以固定 UTC+8 是对的。

**② 节假日**：不维护交易日历（要年年更新，还挡不住台风临时休市），
而是**从数据推断**——盘中去抓一次，如果行情自带的日期**不是今天**，
说明该市场今天没开市，当日不再抓。只在「开盘够久之后」才下这个结论
（刚开盘拿到的可能还是上一交易日的日期）。

---

## 12. 账户余额模型（migration 017）

余额有且只有一个真源：**`accounts.balance`**。它由两条路径共同维护：

| 路径 | 行为 | 实现 |
|---|---|---|
| 有归属的账单增删改 | **增量加减** | `lib/account-balance.ts` 的 `applyTxn()` |
| 手填修正 | **覆盖** | 同文件 `setManualBalance()` |

**不变量**

```
balance == 上次手填的值 + 基准线之后新建的有归属流水的增减
```

**基准线 `accounts.balance_as_of_txn_id`**：手填时记下当前 `MAX(transactions.id)`，
只有 `id > 基准线` 的账单参与加减。

为什么用流水 id 而不是日期或时间戳：

- **日期 + `<=`**：手填当天下午记的账单（业务日期就是今天）会被判成「已含」而永久跳过，
  直接推翻「我改了余额，后续有新账单余额跟着变」。
- **`created_at` 时间戳**：同一秒内无法区分先后，`<` / `<=` 各错一边。
- **自增 id**：单调、无精度问题，且与业务日期解耦——补录昨天的账也会影响当前余额。

**没有归属就不动账户**：551/553 笔历史流水没有 `account_id`，`deltasFor()` 对它们返回空数组，
旧客户端（从不传 `account_id`）行为完全不变。

**迁移回填**

| 账户情况 | balance | 基准线 |
|---|---|---|
| 有手填快照 | 快照值 + 快照**之后**新建的有归属流水 | 快照写入前已存在的 `MAX(id)` |
| 无手填快照 | `initial_balance` + **全部**有归属流水（重放） | `0` |

> ⚠️ 判据是 `EXISTS(asset_snapshots)`，不能用 `balance_as_of_txn_id = 0`——
> 后者会把「有快照但该用户一笔账都没记过」的账户误判为无快照，用 `initial_balance`
> 覆盖掉快照值。
