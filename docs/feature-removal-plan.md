# 废弃功能清理方案 · Feature Removal Plan

> 状态：**调查完成，方案待执行**。本文档只写方案，**未执行任何删除 / DROP / 迁移**。
> 调查方式：全程只读（grep 源码 + `docker exec ... {readonly:true}` 查库），未改动 `server/src/`、未写数据库、未动 `/mnt/Data/billapp`。
> 核查时间：2026-10-09 ｜ 生产容器 `bill-app` 运行中，`transactions` 551 行 / `users` 3 行。

本文档覆盖两件事：

- **任务 A**：`scripts/feature-triage.sh` 新发现的 3 张空表（`user_settings` / `recurring_patterns` / `goal_progress`）到底是什么。
- **任务 B**：下线 5 个废弃功能（预算 / 财务目标 / 订阅 / AI 记忆 / 资产快照）需要动的完整清单、跨功能共享点、DROP 顺序与风险，以及 Android 端文件复核。

---

## 任务 A：三张可疑空表的调查结论

### A.1 `settings` vs `user_settings` —— **不是两代实现，不要误删**

> **triage 文档 §6 的猜测（“`user_settings` 疑似重构遗留旧表，写入路径已迁移到 `settings`”）是错的。** 二者是**不同用途**的两张表，都在用，都不能删。

| 表 | 创建 | 用途 | 结构 | 行数 | 写入路径（活跃） |
|----|------|------|------|------|------------------|
| `settings` | migration001 | **全局** KV 配置（AI Key / 模型 / 币种） | `key PK, value` | **6** | `PUT /api/admin/settings`（admin.ts，管理员 AI 设置页）；`seedSettings` 初始化 |
| `user_settings` | migration001 | **用户级**偏好（覆盖全局） | `(user_id,key) PK, value` | 0 | `PUT /api/settings`（admin.ts `userSettingsRoutes`，已在 routes/index.ts 注册） |

证据：

- 两张表**同在 migration001 创建**（schema.ts:116 / :123），不存在“先后两代”的时间差。
- `settings` 的 6 行实测就是 seed 的 6 个全局键：`ai_api_key` / `ai_base_url` / `ai_model` / `ai_temperature_chat` / `ai_temperature_parse` / `currency`（全部 `updated_at = 2026-09-22`）。全是 AI/全局配置，**没有一条是用户偏好**。
- `user_settings` 的写入路径 `PUT /api/settings`（admin.ts:618-）**活跃且正确**：`allowedKeys = ['default_account_id','theme','ai_model']`，`INSERT OR REPLACE INTO user_settings`。读取路径 `GET /api/settings`（admin.ts:591-）把“全局设置 + 用户级覆盖”合并返回，并刻意屏蔽 `ai_api_key`。
- `user_settings` 为 0 行的真实原因：**没有任何用户保存过个性化偏好**（默认账户/主题/模型都走全局默认），不是“表被废弃”。

**结论**：`settings` 与 `user_settings` 都保留。清理 5 个废弃功能时**绝不能碰这两张表**。

### A.2 `recurring_patterns` —— 服务端从未落地的死表

| 项 | 结论 |
|----|------|
| 创建 | migration008（财务工作台），注释“周期性收支模式表：AI 识别或手动标记的固定收支” |
| 服务端引用 | **零读写**。全仓库唯一出现处是 `admin.ts` 的 `USER_SCOPED_TABLES`（删用户时 purge），没有任何路由 / service / scheduler / seed 写入或读取它 |
| 行数 | 0 |

**判断**：triage 文档的猜测基本成立——它是“智能分类学习”设想的服务端落地表，但**服务端功能从未实现**（没有写入代码）。属于纯死表。是否对应 Android 端“智能分类学习”：Android 源码里无 `recurring`/`pattern` 相关 API/DTO（见 §B.5 扫描），即便 Android 做了也只在本地，未接此表。可随废弃功能一并清理。

### A.3 `goal_progress` —— `financial_goals` 的从属表

| 项 | 结论 |
|----|------|
| 创建 | migration008 |
| 关系 | **主从**。`goal_id INTEGER NOT NULL REFERENCES financial_goals(id) ON DELETE CASCADE` —— 删除目标时进度快照自动连带删除 |
| 服务端引用 | `goals.ts:216` 写入（创建目标时插入初始进度）、`goals.ts:261` 读取（目标进度曲线） |
| 行数 | 0 |

**判断**：不是冗余，是 `financial_goals` 的时间序列从属表。随“财务目标”功能整体进退，DROP 时**必须排在 `financial_goals` 之前**（见 §B.4）。

---

## 任务 B：5 个废弃功能的下线清单

### B.1 删除清单表

图例：**删** = 整文件可删 / **改** = 文件保留但需移除片段 / **留** = 完全不动。

#### 服务端 · 路由层

| 文件 / 符号 | 作用 | 可否删 | 风险 / 备注 |
|-------------|------|--------|-------------|
| `routes/budget.ts`（`budgetRoutes`） | `/api/budgets/*` 全部端点 | **删** | 删后需同步移除 `routes/index.ts` 的 import + `app.register(budgetRoutes)` |
| `routes/goals.ts`（`goalsRoutes`） | `/api/goals/*` | **删** | 同上移除注册 |
| `routes/subscription.ts`（`subscriptionRoutes`） | `/api/subscriptions/*` | **删** | 同上；并处理 scheduler（见下） |
| `routes/memory.ts`（`memoryRoutes`） | `/api/memories/*` | **删** | 同上。注意 `ai_memories` **表不能删**（见 B.2） |
| `routes/assets.ts` | `/api/assets/*` | **改（不可整删）** | **混合文件**：`GET /overview` + `PUT /accounts/:id` 非废弃，必须保留；仅删 `GET /trend` + `POST /snapshot`（这两个用 `asset_snapshots`） |
| `routes/index.ts` | 路由注册中心 | **改** | 移除上述 4 个 register + import，保留 `assetsRoutes` |

#### 服务端 · lib / service（跨功能共享，重点）

| 文件 / 符号 | 被谁用 | 可否删 | 原因 |
|-------------|--------|--------|------|
| `lib/date.ts` | stats / budget / transaction | **留** | 通用日期工具，与废弃功能无关 |
| `lib/budget.ts`（`budgetProgress` 等） | `budget.ts`(废弃) + **`stats.ts` dashboard** + **`transaction.ts:206` 活跃建账预警** | **留** | 删了会直接编译失败/破坏 POST /transactions。即便 budgets 表清空，这个纯函数仍被活跃路径 import |
| `lib/assets.ts`（`summarizeNetWorth`） | **`assets.ts` /overview** + **`stats.ts` dashboard 净资产** | **留** | 两个活跃端点共用，与资产快照无关 |
| `services/scheduler.ts` → `processSubscriptionAutoRecord` | 订阅自动记账 cron | **改** | 订阅下线后此函数失去数据来源（subscriptions 表若 DROP 会报错）。应从 `runScheduledTasks()` 摘除该调用；`processTrashCleanup` / `processLogCleanup` **保留** |

#### 服务端 · 必须“改但保留”的活跃文件（删表前的前置改动）

| 文件 / 位置 | 当前对废弃表的引用 | 处置 |
|-------------|-------------------|------|
| `stats.ts:359`（dashboard `budget_progress`） | `SELECT ... FROM budgets` | DROP `budgets` 前先把这段改成返回空数组常量（**响应字段保留**，见 B.3） |
| `stats.ts:498`（dashboard `goals_top`） | `SELECT ... FROM financial_goals` | DROP `financial_goals` 前先改为空数组 |
| `stats.ts:473 / :547`（`subscriptions_overview` + `subscription_due` alert） | `SELECT ... FROM subscriptions` | DROP `subscriptions` 前先改为空/跳过 |
| `transaction.ts:182-207`（POST /transactions 建账后预算预警） | `SELECT ... FROM budgets` | DROP `budgets` 前先移除这段；`budget_warnings` 字段可保留为空数组 |
| `export.ts:29-38`（GET /export/json 备份） | `SELECT * FROM budgets` | DROP `budgets` 前先移除 `budgets` 读取与 `data.budgets` 字段 |
| `ai.ts:150`（AI 解析注入用户偏好） | `SELECT content FROM ai_memories ... source='manual'` | 见 B.2——**ai_memories 不随 /api/memories 下线而 DROP** |
| `ai.ts:380-397`（解析修正自动学习写入） | `INSERT INTO ai_memories ... source='ai_suggested'` | 同上，服务端活跃写入，保留表 |
| `admin.ts` `USER_SCOPED_TABLES`(22-34) | 列出 7 张废弃/半废弃表用于删用户 purge | DROP 某表后，**同步从此数组移除对应行**，否则 purge 时 `DELETE FROM <已删表>` 报错 |

#### 服务端 · migration / schema

| 位置 | 处置 |
|------|------|
| `schema.ts` migration004/005/008 的建表语句 | **不要改历史 migration**（幂等已跑过的 migration 改了也不重放）。清理走**新增一条 migration**（如 012）做 `DROP TABLE`，而不是编辑旧的 |
| `db/index.ts` migrations 数组 | 新增 012 条目；旧条目不动 |

#### 服务端 · 测试

| 文件 | 处置 | 备注 |
|------|------|------|
| `tests/routes/budgets.test.ts` | **删** | 对应 budget 路由 |
| `tests/routes/subscriptions.test.ts` | **删** | |
| `tests/routes/memories.test.ts` | **删** | |
| `tests/routes/stats-dashboard.test.ts` | **改** | 若断言了 `budget_progress`/`goals_top`/`subscriptions_overview` 的内部结构，改为断言“恒为空数组”；**不要删整文件**（dashboard 本身活跃） |
| `tests/routes/networth.test.ts` | **留 / 复核** | 覆盖 `/assets/overview` + dashboard 净资产，这些保留；确认不涉及 trend/snapshot |
| goals 无独立测试文件 | — | grep 未见 `tests/routes/goals.test.ts` |

> 注：已 `ls tests/routes/` 核实——存在的测试文件为 admin / ai-chat / auth / budgets / import / memories / networth / stats-dashboard / subscriptions / transactions。**无 `goals.test.ts`、无 `assets.test.ts`**（这两个功能无独立路由测试）。

### B.2 ⚠️ 特例：`ai_memories` 表 ≠ `/api/memories` 功能

这是最容易踩的坑：**`/api/memories/*` 路由废弃（客户端无入口），但 `ai_memories` 表被 AI 解析主流程活跃读写**：

- `ai.ts:150`：解析记账时读 `source='manual'` 的记忆注入 system prompt（用户偏好）。
- `ai.ts:380-397`：用户修正解析结果时，自动写入 `source='ai_suggested'` 记忆（“解析修正自动学习”）。

因此：**可以删 `routes/memory.ts` + 下线 `/api/memories/*`，但 `ai_memories` 表必须保留**，否则 AI 记账解析会报错。表当前 0 行**不是因为「没人修正过」，而是因为反馈链路根本没接通**：
`POST /api/ai/parse-feedback` 在 `app_logs` 中**零记录**（该接口是 POST，会被日志钩子记录，所以「零记录 = 从未被调用」成立），`ai_parse_logs.user_modified` 1415 条全为 0。
Android 端完全没有调用该接口，Web 端受 `if (parseLogId.value)` 限制也未触发过。
连带影响：管理面板「修正率」指标**恒为 0%**，会误导管理者认为「AI 解析很准，不需要人工修正」。
这是典型的「看着像没需求，实际是没接通」——详见 docs/FEATURE-TRIAGE.md §7 反例 3。
→ `ai_memories` 从本次“DROP 表”清单中**排除**。

### B.3 必须保持不变（硬约束）

1. **`GET /api/stats/dashboard` 响应结构**：`budget_progress` / `goals_top` / `subscriptions_overview` 三个字段**必须继续存在**（值可恒为空数组/空对象），以免已发布 Android App 解析崩溃。改法是“把取数据的 SQL 换成空值常量”，不是“删字段”。
2. **导出接口** `GET /api/export/json`：结构里 `budgets` 字段的去留取决于是否要兼容旧备份文件的恢复逻辑；最保守做法是保留字段、值为 `[]`。CSV 导出不涉及废弃表，不动。
3. **`USER_SCOPED_TABLES` 删除顺序**：子表必须排在 `categories` / `accounts` 两张父表之前（`PRAGMA foreign_keys=ON` 下先删父表会抛 `SQLITE_CONSTRAINT_FOREIGNKEY`）。每 DROP 一张表，就从该数组移除对应行。

### B.4 DROP 表顺序与风险

**待 DROP 的表（4 张）**：`budgets`、`financial_goals`、`goal_progress`、`subscriptions`、`asset_snapshots`、`recurring_patterns`。
**明确不 DROP**：`ai_memories`（B.2）、`settings`、`user_settings`（A.1）。

外键依赖（均 `PRAGMA foreign_keys=ON`）：

```
goal_progress ── FK goal_id → financial_goals(id) ON DELETE CASCADE   ← 唯一的表间链
financial_goals ── FK linked_account_id → accounts
budgets        ── FK（category_id 默认 0，弱引用）→ categories
subscriptions  ── FK category_id/account_id → categories/accounts
asset_snapshots── FK account_id → accounts
recurring_patterns ── FK category_id/account_id → categories/accounts
```

**DROP 顺序**（新增 migration 012 内）：

```sql
-- 1) 先删从属表（否则违反 goal_progress → financial_goals 外键）
DROP TABLE IF EXISTS goal_progress;
DROP TABLE IF EXISTS financial_goals;
-- 2) 其余表彼此无依赖，顺序不敏感；它们只引用 users/categories/accounts（父表保留）
DROP TABLE IF EXISTS budgets;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS asset_snapshots;
DROP TABLE IF EXISTS recurring_patterns;
```

**风险评估**：

| 风险 | 评级 | 说明 / 缓解 |
|------|------|-------------|
| 生产库 551 笔交易受影响 | **无** | 待删 6 张表全部 0 行；`transactions` / `categories`(57) / `accounts`(13) 不在删除范围 |
| DROP 前代码仍引用表 → 运行时报错 | **高（若顺序错）** | **必须先发代码**（stats/transaction/export/scheduler 去引用 + 摘路由），**确认线上生效后再发 DROP migration**。顺序颠倒会使 dashboard/建账/导出 500 |
| Android 旧版仍调废弃接口 → 404 | **中** | 见 §4 安全规则——路由删除要等 Android 清完；期间可保留路由只删 Web 入口（现状即如此） |
| DROP 不可逆 | **高** | migration 不可回滚 SQLite 的 DROP。**执行前必须备份** `~/.bill/bill.db`（README 已有备份命令） |
| 外键约束报错 | **低** | 按上面顺序 + 父表保留即可规避；`goal_progress` 虽 CASCADE，仍显式先删更稳 |

**是否需要迁移脚本**：需要。走**新增 migration（012）**，不编辑历史 migration（001/004/005/008 已应用，改了不重放）。

### B.5 Android 端（`/mnt/Data/billapp`）文件清单复核

> 只读 grep 复核，未改动 Android 仓库。扫描范围 `app/src/main/**/*.kt`（184 个源文件，排除 `build/`）。

| 功能 | 数据层文件 | presentation 引用 | 结论 |
|------|-----------|-------------------|------|
| 预算 Budget | 4 文件：`domain/repository/BudgetRepository.kt`、`data/repository/BudgetRepositoryImpl.kt`、`data/remote/dto/response/BudgetResponse.kt`、`data/remote/api/BudgetApi.kt` | **0** | 与你的结论一致——数据层四层齐备、UI 零入口 |
| 财务目标 Goal | **无任何文件** | 0 | **Android 从未实现**（连数据层都没有） |
| 订阅 Subscription | **无任何文件** | 0 | 同上 |
| AI 记忆 Memory | **无任何文件** | 0 | 同上 |
| 资产快照 Snapshot | **无任何文件** | presentation 有 2 处“Snapshot”但是 **误报** | 命中的是 `PagingFilterSnapshot`（交易列表分页过滤快照），与资产快照无关 |

**对你“4 个文件”说法的修正/补充**：

- Budget 的**源文件是 4 个**（如上），**但 Hilt 绑定不是独立文件，而是写在两个共享 DI 文件里的若干行**：
  - `di/NetworkModule.kt:6`（import）、`:113-114`（`provideBudgetApi`）
  - `di/RepositoryModule.kt:6,:18`（import）、`:63`（`bindBudgetRepository`）
  这两个 DI 文件是**全局共享**的，**不能删文件**，只能删其中与 Budget 相关的行。
- 所以 Android 侧 Budget 清理 = **删 4 个源文件 + 改 2 个 DI 文件（移除 Budget 行）**，共涉及 6 个文件。
- Goals / Subscriptions / Memories / Snapshot 在 Android 源码里**完全不存在**（README 写“无引用”准确），无需任何改动。

> Android 实际改动由对方 agent 负责，这里仅复核清单准确性。

---

## 建议执行顺序（分 3 阶段，严格串行）

遵循 FEATURE-TRIAGE §4 安全规则：**先前端 → 再服务端代码 → 最后 DROP 表**，且跨仓库有先后。

**阶段 0 · 前置（已完成）**
- Web 入口已下线、旧路由已 302、接口标 deprecated。现状即此。

**阶段 1 · 等 Android 清完数据层**（跨仓库，阻塞点）
1. Android 删除 Budget 4 文件 + 改 2 个 DI 文件；确认 `goals/subscriptions/memories/snapshot` 本就无引用。
2. Android 发版，确认线上 App 不再依赖 `/api/budgets` 等接口。

**阶段 2 · 服务端代码去引用（不碰表，可独立验证）**
1. `stats.ts`：`budget_progress`/`goals_top`/`subscriptions_overview` 改为空值常量（**保字段**）。
2. `transaction.ts:182-207`：移除建账后预算预警读 `budgets` 的分支。
3. `export.ts`：移除 `budgets` 读取（字段保留为 `[]` 或移除，二选一，倾向保留兼容）。
4. `scheduler.ts`：从 `runScheduledTasks()` 摘掉 `processSubscriptionAutoRecord`。
5. 删 `routes/{budget,goals,subscription,memory}.ts` + 从 `routes/index.ts` 摘注册；`routes/assets.ts` 仅删 `/trend` + `/snapshot`。
6. **保留** `lib/budget.ts`、`lib/assets.ts`、`lib/date.ts`、`ai_memories` 全部读写、`settings`/`user_settings`。
7. 改/删对应测试；跑 `npm run build` + `npm test` 全绿。
8. 部署，确认 dashboard / 建账 / 导出 / AI 解析正常。

**阶段 3 · DROP 表（不可逆，最后做）**
1. **先备份** `~/.bill/bill.db`。
2. 新增 migration 012，按 §B.4 顺序 DROP 6 张表（含 `recurring_patterns`，排除 `ai_memories`）。
3. 从 `USER_SCOPED_TABLES` 移除这 6 张表对应行。
4. 部署，`PRAGMA foreign_key_check` 应通过，dashboard/建账/删用户功能回归。

---

## 我认为你判断需要修正的地方

1. **`user_settings` 不是 `settings` 的旧版/遗留表**（triage §6 的猜测错了）。两张同在 migration001、用途不同（全局 KV vs 用户偏好），`user_settings` 的写路径 `PUT /api/settings` 活跃。**清理时必须跳过这两张表**——这正是你担心“搞错会误删正在用的表”的点，结论是：别删。
2. **`ai_memories` 表不能跟着 `/api/memories` 一起 DROP**。路由废弃 ≠ 表废弃——AI 记账解析主流程在 `ai.ts` 活跃读写它。只下线路由、保留表。
3. **DROP `budgets`/`financial_goals`/`subscriptions` 不是“纯空表随便删”**：`stats.ts`(dashboard) + `transaction.ts`(建账) + `export.ts`(备份) 这几个**活跃**路径仍在 SELECT 这些表。必须**先改代码去引用、部署生效，再 DROP**，否则线上 500。
4. **`routes/assets.ts` 是混合文件**，不能整删——`/overview` 和 `PUT /accounts/:id` 是非废弃功能，只有 `/trend` + `/snapshot` 该删。
5. Android 的 Budget“4 个文件”准确，但**Hilt 绑定在 2 个共享 DI 文件里（改行，不删文件）**；且 Goals/Subscriptions/Memories/Snapshot 在 Android **压根没有数据层**（比“无 UI 引用”更彻底）。
