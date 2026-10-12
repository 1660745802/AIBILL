# API 接口文档

> **Base URL**: `http(s)://<host>:3000/api`
> **认证**: 除 `/health`、`/api/auth/*`、`/api/config/notification-rules`、`/api/app/update` 外均需 `Authorization: Bearer <jwt>`
> **响应格式**: 统一 `{ code: 0, data: <T>, message: "" }`
> **路由**: 见 `server/src/routes/*.ts`。本文档逐条枚举全部 90 个端点；
> 若与 `scripts/gen-api-docs.ts` 输出不一致，**以脚本为准**（它直接读 `routes/*.ts`）。

> ⚠️ **已废弃接口（deprecated，2026-10）**：`/api/budgets/*`、`/api/goals/*`、
> `/api/subscriptions/*`、`/api/memories/*`（`/api/assets/snapshot`、`/api/assets/trend` 路由已删）。
> **权威说明、判定依据与「表可否删」见 [PRODUCT.md §3.2](PRODUCT.md)**（唯一真源，此处不再重复）。
> 注意：`ai_memories` / `asset_snapshots` **两张表不可删**（被主流程活跃读写，删了是故障）；
> `GET /api/stats/dashboard` 响应结构保持不变（`budget_progress` / `goals_top` /
> `subscriptions_overview` 字段保留、值恒为空），保证已发布客户端解析不受影响。

---

## 0. 通用规则

### 0.1 响应包装
```json
// 成功
{ "code": 0, "data": {...}, "message": "" }

// 错误
{ "code": 1001, "data": null, "message": "未提供认证令牌" }
```

### 0.2 HTTP 状态码

| Status | 含义 |
|--------|------|
| 200 | 成功（看 body.code） |
| 400 | 参数错误 |
| 401 | 未认证 / Token 过期 / 已撤销 |
| 403 | 权限不足（需 admin） |
| 404 | 资源不存在 |
| 429 | 限流 |
| 502/504 | AI 服务异常 |

### 0.3 业务错误码

| 范围 | 含义 |
|------|------|
| 0 | 成功 |
| 1xxx | 认证/授权 |
| 2xxx | 参数校验 |
| 3xxx | 业务逻辑 |
| 4xxx | 外部依赖 |
| 5xxx | AI 相关 |

| Code | 含义 |
|------|------|
| 1001 | 未提供 Token |
| 1002 | Token 无效/过期/已撤销 |
| 1003 | 权限不足 |
| 1004 | 用户名或密码错误 |
| 1005 | 账号已禁用 |
| 1006 | Token 已被撤销（改密/重置） |
| 1007 | 当前密码错误 |
| 2000 | 参数校验失败 |
| 2001 | 邀请码无效/过期/用完 **或** 手填余额时账户校验失败（不存在/不属于你/已停用）。两个域共用一个码是历史遗留（快照路径一直用它）；若客户端要特判邀请错误，需先判 HTTP 400 + message 或拆分新码（未做） |
| 2002 | 用户名已存在 |
| 2003 | 业务校验失败 |
| 3001 | 唯一约束冲突 |
| 3002 | 资源不存在 |
| 3003 | 不能操作自己 |
| 5001 | AI 解析失败 |
| 5002 | AI 响应格式异常 |
| 5003 | AI 问答失败 |

**框架级错误出口**（`server/src/app.ts`，不在路由里手工返回）：

- 全局 `setErrorHandler` 统一回 `{ code: <HTTP 状态码>, data: null, message }`——
  即 **`code` 等于 HTTP 状态码**。例：body JSON 解析失败 / 超限 / CORS 拒绝回 `400 / code:400`，
  未捕获异常回 `500 / code:500`（message 固定为「服务器内部错误」，不泄漏堆栈）。
- `setNotFoundHandler`：`/api/*` 路径不存在 → `404 / code:4004`（前端静态资源走 SPA fallback，不适用）。
- APK 下载路由特例：文件名/路径非法 → `400 / code:4000`；文件不存在 → `404 / code:4004`。

### 0.4 字段约定

| 项 | 约定 |
|----|------|
| 金额单位 | **整数（分）**，¥32.50 → 3200 |
| 日期 | `YYYY-MM-DD` |
| 时间 | `HH:mm` |
| 时间戳 | `datetime('now')` 字符串或 ISO8601 |
| 列表响应 | `{ items: [...], total, page, page_size }` |
| 分页 | `page`（从1）、`page_size`（默认20，最大100） |
| 幂等 | `POST /transactions` 用 `client_id` |

---

## 1. 认证 `/api/auth/*` & `/api/settings`

### POST `/api/auth/register`
无需认证。**限流：5/分钟**。
```json
// Request
{ "username": "zhangsan", "password": "12345678", "invite_code": "ABC12345", "nickname": "张三" }
// Response 200
{ "code": 0, "data": { "token": "eyJ...", "user": { "id": 1, "username": "zhangsan", "nickname": "张三", "role": "user" } }, "message": "" }
```

### POST `/api/auth/login`
无需认证。**限流：5/分钟**。
```json
{ "username": "zhangsan", "password": "12345678" }
```
成功返回 `{ token, user }`；密码错误返回 1004；账号禁用 1005。

### GET `/api/auth/me`
返回 `{ user: {...} }`。

### PUT `/api/auth/password`
```json
{ "old_password": "...", "new_password": "newpass123" }
// Response
{ "code": 0, "data": { "token": "<新 token>" }, "message": "密码修改成功" }
```
改密成功后**自动撤销该用户所有现存 token**（`users.token_version` 自增），并**为当前设备换发新 token**（客户端应立即写入 localStorage）；其他设备需重新登录。

### GET `/api/settings`
返回合并后的设置（用户覆盖 > 全局）。普通用户**看不到 AI Key**。

### PUT `/api/settings`
白名单字段：`default_account_id` / `theme` / `ai_model`（覆盖全局模型）。

---

## 2. 交易 `/api/transactions/*`

### POST `/api/transactions`
**批量 + 幂等**。items 单条通用契约见 [ARCHITECTURE.md §2.4](ARCHITECTURE.md)。
```json
{ "items": [
  { "client_id": "uuid", "client_type": "web", "source": "ai",
    "type": "expense", "amount": 3200, "category_id": 1, "account_id": 1,
    "description": "午饭", "date": "2026-07-02", "time": "12:30",
    "tags": ["工作日"], "ai_raw_input": "午饭32" }
] }
// Response
{ "code": 0, "data": { "created": [...], "duplicates": [...] }, "message": "" }
```
幂等：同 `user_id + client_id` 不入库，挪到 `duplicates`。批量上限 **200** 条/请求（CSV 导入按 100 条分片提交）。

### GET `/api/transactions`
支持 `page` / `page_size` / `start_date` / `end_date` / `type` / `category_id` / `account_id` / `keyword` / `tag`。

### GET `/api/transactions/:id`
单条详情。

### PUT `/api/transactions/:id`
部分字段更新。

### DELETE `/api/transactions/:id`
软删除（设 `deleted_at`），可恢复。

### GET `/api/transactions/trash`
已软删除列表。

### POST `/api/transactions/:id/restore`
恢复软删除记录。

### DELETE `/api/transactions/:id/permanent`
永久物理删除。

### GET `/api/transactions/tags`
返回当前用户所有用过的标签（去重）。`{ items: ["旅行", "报销"] }`

---

## 3. AI `/api/ai/*` & `/api/memories/*`

### POST `/api/ai/parse`
**限流：20/分钟**。用户输入 `<user_input>` 包裹后送 LLM。**完整契约（8 种响应形态、
入参/出参扩展、跨端约定）见 [recognition-flow.md §1/§5/§6](recognition-flow.md)**；此处只列要点：
```jsonc
// Request（只有 input 必填；其余可选，不传时行为与旧版完全一致）
{ "input": "午饭32，打车15",
  "channel": "nls",                                  // nls | sms | a11y | manual
  "source": { "package_name": "com.tencent.mm", "source_name": "微信支付" },
  "title": "...", "body": "...",
  "received_at": "2026-10-12T23:40:00+08:00",        // 必须带时区偏移
  "hints": { "amount_cents": 3200, "merchant": "美团" } }
// Response 成功（items 元素在原有键之外**追加**机械推导字段）
{ "code": 0, "data": { "items": [{
    "type": "expense", "amount": 3200, "category_id": 1, "category_name": "餐饮",
    "category_icon": "🍜", "description": "午饭", "date": "2026-07-02",
    "account_id": null, "account_name": "", "target_account_id": null, "target_account_name": "",
    // —— 追加（不进 prompt、不写账本，客户端做本地校验用）——
    "merchant": null, "order_no": null, "card_tail": null,
    "balance_after_cents": null, "balance_text": null, "time": null,
    "confidence": "high", "confidence_reasons": ["quick","category_exact","amount_unit"],
    "needs_review": false }],
  "raw_input": "...", "parse_log_id": 123, "source": "quick", "hints_conflict": false },
  "message": "" }
// 失败 fallback
{ "code": 5001, "data": null, "message": "AI 无法解析...", "fallback": "manual",
  "raw_input": "...", "parse_log_id": 123 }   // ⚠️ 失败态在**顶层**，成功态在 data 里
```
- `source`：`quick`（正则快捷）/`ai`（模型）/`prefilter`（入站预筛挡下，**无 parse_log_id**）/
  `postfilter`（出站判为噪声，**无 parse_log_id**）。
- `confidence` 是**枚举** `high|medium|low`（服务端派生，非模型自评）；**待审判据请用 `needs_review`**，
  不要自己对 `confidence` 设阈值。
- `balance_after_cents` 仅是提示，**服务端不会用它改余额**。

### POST `/api/ai/filter-report`
**限流：20/分钟**。客户端上报「发请求前拦掉了什么」（按窗口聚合计数），供 admin 侧与服务端口径对照。
```jsonc
{ "window_start": "2026-10-12 00:00:00", "window_end": "2026-10-12 23:59:59",
  "client_version": "1.4.0", "channel": "nls",
  "counts": [{ "rule_id": "precheck.coupon_facevalue", "count": 3 },
             { "rule_id": "client_only.SELF_NOTIFICATION", "count": 9 }],
  "totals": { "notifications": 100, "blocked": 53 } }
// Response
{ "code": 0, "data": { "accepted": 2, "unknown_precheck_ids": [] }, "message": "" }
```
- `rule_id` 只允许 `precheck.*`（命中服务端下发的判据，**可比**）或 `client_only.*`
  （客户端独有判据，**服务端无对应**）；第三个前缀 → 400。
- **幂等 = 覆盖**：同 (user, client_version, channel, 窗口, rule_id) 重复上报改写而非累加。
- 无时区的窗口串按**北京时间**解释，存储与去重统一为 **UTC**；`2026-10-12T00:00:00+08:00`
  与 `2026-10-12 00:00:00` 是同一个键。
- 新表 `client_filter_stats` / `client_filter_totals`（migration021），详见
  [recognition-flow.md §4](recognition-flow.md)。

### POST `/api/ai/parse-feedback`
记录用户是否修正（用于质量统计 + 自动学习）。

### POST `/api/ai/chat`
```json
{ "message": "这个月花了多少？", "session_id": "abc-123-or-null" }
// Response
{ "code": 0, "data": { "message": "本月总支出 ¥3,280...", "session_id": "abc-123" }, "message": "" }
```

### GET `/api/ai/sessions`
返回对话列表。

### DELETE `/api/ai/sessions/:id`
删除整个会话。

### `/api/memories/*`（AI 全局记忆）
| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/memories` | 当前用户所有 memory |
| POST | `/api/memories` | 新增（`source: manual \| ai_suggested`） |
| PUT | `/api/memories/:id` | 更新内容/启用状态 |
| DELETE | `/api/memories/:id` | 删除 |

**注入约束**：LLM prompt 只取 `source='manual'`，排除 `ai_suggested`。

---

## 4. 分类 `/api/categories/*` & 账户 `/api/accounts/*`

### `/api/categories`
| Method | 说明 |
|--------|------|
| GET | 列出当前用户分类，可 `?type=expense&include_inactive=1` |
| POST | 创建 `{ name, type, icon, sort_order }` |
| PUT | 更新（部分字段） |
| DELETE | 停用（`is_active=0`，不真删） |

### `/api/accounts`
| Method | 说明 |
|--------|------|
| GET | 列出账户，含 `current_balance`（= `accounts.balance`，017 起的权威余额）。`?include_inactive=1` 连已删除的一起返回 |
| POST | 创建账户。支持 `asset_type`（**直接建对类型**，不必建完再去资产页改一次）；`initial_balance` 可负 |
| PUT | 更新；**支持 `current_balance`**（推荐）—— 017 起为**覆盖**余额并刷新基准线 |
| DELETE | **删除账户**（软删，可还原）。连带清掉该账户的余额快照与持仓 |
| POST `/api/accounts/:id/restore` | 还原误删的账户 |

> `PUT /api/accounts/:id` 是**请求级原子**的：改余额（会同时写一行快照凭证）与改其它字段
> 在同一个事务里。任一步失败则整单不生效——例如同一请求里既改 `current_balance`
> 又把 `name` 改成已存在的名字，余额**不会**被写进去。
>
> 失败响应与 `POST /api/accounts` 统一：

| 场景 | HTTP | `code` | `message` |
|---|---|---|---|
| 账户不存在 / 不属于当前用户 | 404 | 3002 | `账户不存在` |
| **账户已停用**（`is_active=0`）且请求要改余额 | 400 | 2001 | `账户 N 已停用，不能修改余额` |
| 没有任何可更新字段 | 400 | 2000 | `没有需要更新的字段` |
| `name` 与该用户已有账户重名 | 400 | 3001 | `账户名称已存在` |

> **停用账户不可写余额（D3）**：`current_balance` / `initial_balance` 会被拒，
> 但**仍可改它的其它字段**（改名、排序等）。停用账户要写余额，须先
> `POST /api/accounts/:id/restore` 还原；也允许在**同一个请求**里
> `{ is_active: 1, current_balance: X }` 一次完成（判据是「请求结束后是否活跃」，
> 而不是库里旧值）。理由：停用账户不在任何读模型里（`is_active=1` 才进），
> 写余额等于写进一个不被读的地方。

> 曾经重名会抛成 `SQLITE_CONSTRAINT_UNIQUE` → **HTTP 500 且把 SQLite 原文透给客户端**，
> 而余额已经被覆盖、快照行也已经写进去了。两处都已修。

`account.type`（付款渠道，历史字段）：`cash | wechat | alipay | bank | credit | other`
`account.asset_type`（**账户种类**，UI 按它分组、决定要不要出现「投资」页）：
`liquid | savings | investment | credit | loan | property | other`

**删除账户时流水会保留**（`transactions` 上有到 `accounts` 的真实外键，
且流水是账本事实不是账户的附属品），只是不再计入该账户余额。
`DELETE` 的响应 `data.transactions` 会告诉你有多少笔账单受影响。

**理财账户的 `current_balance` 语义是「现金」**，不是账户总价值——
总价值 = 现金 + 持仓市值，持仓市值由 `/api/investments` 单独给出。

---

## 5. 统计 `/api/stats/*`

### GET `/api/stats/summary?year=2026&month=7`
返回 `{ expense, income, balance, expense_count, income_count, prev_expense, prev_income, expense_change, income_change }`。`change` 为环比百分比（整数，可能为 null）。

### GET `/api/stats/by-category?year=2026&month=7&type=expense`
`{ items: [{ id, name, icon, total, count, percent }], total, year, month, type }`

### GET `/api/stats/trend?year=2026&month=7&period=daily&type=expense`
- `period=daily`：补全当月所有日期（无数据 total=0）
- `period=monthly`：最近 12 个月

### GET `/api/stats/dashboard`
聚合首页仪表盘：本月收支 + 净资产 + 趋势 + 分类饼图 + 预算进度 + 异常提醒。

**净资产口径**（与 `/api/assets/portfolio` 同一个读模型、逐分相同，见 `lib/portfolio.ts`）：
- `net_worth.total` = Σ 账户总价值 = Σ(现金 + 持仓市值)。行情缺失的账户只计入已知的现金 → 这是**下界**
- `net_worth.netWorthComplete`：`false` 时 `total` 是下界，UI 必须显示「≥¥X」而不是当精确值
- `net_worth.unpricedAccounts`：因行情缺失无法估值的账户数
- `net_worth.accounts[]` = `{ id, name, icon, asset_type, cash, value }`
  - `cash` = 现金；`value` = 总价值（现金 + 持仓市值），行情缺失为 `null`
  - **净资产用的是 `value`，不是 `cash`**——挂了持仓的账户两者差一整块持仓市值

> ✅ **已删除 `total_assets` / `total_liabilities` / `asset_breakdown`**（D1）。
> 它们是 `Σ accounts.balance` 的**现金口径**第二套算法，Web / Android 均零消费者
> （Android 根本不调本接口）。要资产/负债拆分与构成，请用
> `GET /api/assets/portfolio` 的 `liability` / `assetComposition`。

### POST `/api/stats/analysis`
```json
// Request
{ "type": "overview | spending | forecast" }
// Response
{ "code": 0, "data": {
    "type": "overview",
    "analysis": "AI 生成的报告…",
    "data_summary": {
      "months": [{ "month": "2026-10", "expense": 0, "income": 0 }],
      "categories": [{ "name": "…", "icon": "…", "total": 0 }],
      "net_worth": 0,
      "net_worth_complete": true,
      "unpriced_accounts": 0
    },
    "generated_at": "…"
}, "message": "" }
```
服务端**单条 `GROUP BY substr(date,1,7)`** 取多个月数据。

**`net_worth` 是总价值**（现金 + 持仓市值），与 `GET /api/assets/portfolio`
逐分相同。曾经这里是裸的 `SUM(accounts.balance)`，是同一个数字在服务端的
**第三套**算法 —— 差着一整块持仓市值，而这个数被**写进 AI 提示词**，
于是 AI 会把漏算的净资产当成事实写进分析报告。

行情缺失的账户只计入现金 → `net_worth` 可能是**下界**，必须配
`net_worth_complete` / `unpriced_accounts` 读。提示词里也带这个约束：
不完整时写「净资产: ≥¥X」，而不是把下界说成精确值。

---

## 6. 预算 `/api/budgets/*`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/budgets?year=2026&month=7` | 列表 + `spent` + `percent` + `status`（`normal/warning/exceeded`） |
| POST | `/api/budgets` | 创建（`category_id=0` = 总预算） |
| PUT | `/api/budgets/:id` | 更新 |
| DELETE | `/api/budgets/:id` | 删除 |

---

## 7. 导入导出 `/api/import/*` `/api/export/*`

### POST `/api/import/csv`
```json
{ "content": "CSV文件全部文本...", "source": "wechat | alipay" }
// Response
{ "code": 0, "data": {
    "parsed": [{
      "type": "expense", "amount": 3250, "description": "外卖订单",
      "date": "2026-09-20", "source_detail": "微信-美团",
      "category_id": 12, "category_name": "餐饮", "category_icon": "🍜",
      "category_auto": true,   // true = 由商户关键词规则自动预填，用户可在预览中改
      "duplicate": false       // true = 与已有记录（同 user+type+amount+date+description）重复
    }],
    "total": 250, "skipped": 0, "errors": 1, "duplicates": 3
  }, "message": "" }
```
**只解析不直接入库**，前端预览确认后组装 items 调 `POST /api/transactions`（建议 100 条/批）。
- 分类按商户关键词预填（如「美团→餐饮」「滴滴→交通」），命中不了则归入「其他」；用户删除对应分类时自动回退到「其他」。
- 重复检测同时对比**已有记录**与**同一批次内部**；回收站（已软删除）中的记录不计入重复。

### GET `/api/export/json`
返回 JSON 文件下载（Content-Disposition: attachment）。含 transactions + categories + accounts + budgets。

### GET `/api/export/csv?start_date=&end_date=`
返回 CSV（UTF-8 BOM，Excel 兼容）。列：日期,类型,金额(元),分类,账户,描述。

---

## 8. 资产 `/api/assets/*`（财务工作台）

### GET `/api/assets/overview`
返回 `{ accounts: [...] }`。**单条聚合 SQL**（已修 N+1）。

**只提供账户元数据 + 每账户现金余额**（`balance` = `accounts.balance`），
不含任何净资产口径的字段。

> ✅ **已删除 `total_assets` / `total_liabilities` / `net_worth` / `by_type`**（D1）。
> 它们是 `Σ accounts.balance` 的现金口径第二套算法，Web 对它们零使用
> （`Assets.vue` 只取 `accounts[]` 的 id/name/asset_type/icon），Android 不调本接口。
>
> **净资产 / 负债 / 构成只有一个真源：`GET /api/assets/portfolio`。**
> 前端仪表读数一律以 `/api/assets/portfolio` 为准。

### GET `/api/assets/portfolio` — 工作台读模型（净资产口径的**权威来源**）
返回 `{ netWorth, netWorthComplete, unpricedAccounts, hasReadings, assetComposition,
liability, investment, curve, accounts, empty, lastUpdated, change, previousNetWorth, ... }`（camelCase）。

| 字段 | 含义 |
|------|------|
| `netWorth` | Σ(各账户总价值)，总价值 = 持仓市值 + 现金。行情缺失的账户只计现金 → 这是**下界** |
| `netWorthComplete` / `unpricedAccounts` | false = 有 N 个账户算不出总额，UI 显示 `≥¥X` |
| `hasReadings` | 有没有余额读数（017 判据）：任一活跃账户**有快照行**、**余额非 0**、**或持仓能估值**；三者都不满足才算「没有读数」 |
| `empty` | 旧字段：有没有写过 `asset_snapshots` 行。**不等于**「没有余额读数」 |
| `assetComposition` | `{ state, total, rows: [{ type, value, percent }] }`。按 `asset_type` 用账户总价值分组；`percent` 分母 = **正资产合计**（**负债账户不进构成条**，见 UI-DESIGN §6.8 规则 7，负债由 `liability` 单列）；`state ∈ ok \| no_readings \| no_positive_assets`，不变式 `rows.length > 0 ⟺ state === 'ok'`。⚠️ **例外**：现金为负但总价值为正的账户会**同时**进构成条与 `liability`（构成按 `value > 0` 判、负债按 `cash < 0` 判），故 `total − liability.total ≠ netWorth`，别当恒等式 |
| `liability` | `{ total, accountCount }`，负余额账户合计（**负数**）。判据是 **`cash < 0`**（与构成条的 `value > 0` 不同，见上一行的例外） |
| `previousNetWorth` / `change` / `changeRate` | 上一次「全员账户都覆盖过」的读数与日变动。**口径与 `netWorth` 完全一致**（未定价账户计现金）；找不到全量覆盖日时三者皆 `null`。**当前 web 端无消费者**，留给其他端 |

### PUT `/api/assets/snapshots`
手填余额（覆盖 + 推进基线 + upsert 快照行），可带 `date` 补录。
余额与快照凭证由同一个事务写入；整个请求也包在事务里，
所以“改余额的同时改其它字段而后者失败”时不会留下半改的数据。

停用账户（`is_active=0`）同样被拒（D3，与 `PUT /api/accounts/:id` 口径一致）：
400 / `code 2001` / `账户 N 已停用，不能修改余额`。

### PUT `/api/assets/accounts/:id`
更新账户资产属性：`asset_type` / `currency` / `credit_limit` / `billing_day` / `due_day` / `note`。

---

## 8.1 投资持仓 `/api/investments/*`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/investments` | 持仓列表 + 逐条估值。含 `quote.status`（行情状态）与 `quote.schedule`（为什么没自动更新） |
| POST | `/api/investments` | 新增/复活持仓 `{ account_id, code, name?, kind?, quantity, note? }`。**加完立刻取价** |
| PATCH | `/api/investments/:id` | 改股数 / 名称 / 备注 |
| DELETE | `/api/investments/:id` | 软删（可重新加回，唯一约束不看 `is_active`） |
| POST | `/api/investments/quotes/refresh` | **手动刷新行情**（见下） |

`code` 一律后端 normalize：`518880` / `sh518880` / `518880.SH` 都归一成 `sh518880`。
行情缺失时 `marketValue = null`（**不是 0**），UI 显示 `—`。

### POST `/api/investments/quotes/refresh`

手动刷新的端点**绕过交易时段门禁**（用户明确要求就去取），并**逐个代码回报结果**，
而不是像定时任务那样静默跳过。汇率顺带取（主源腾讯 → ECB 兜底）。

```jsonc
{ "code": 0, "data": {
    "total": 2, "fetched": 1,
    "schedule": { "fetch": true, "reason": "A股盘中" },   // 按该用户**实际持仓**的市场算
    "at": "2026-10-11 10:00:00",
    "network": true,                                        // false = 这一轮没拿到任何可解析行情
    "results": [{ "code": "sh518880", "ok": true, "price": 8.617, "quoteDate": "2026-10-09" }],
    "missing": [{ "code": "hk0100", "reason": "腾讯不认这个代码（hk0100），检查是不是多/少了字符" }],
    "fx": { "HKD": 0.8525 }, "fxSource": "tencent"         // 来源可为 tencent | ecb | mixed | none
  },
  "message": "1 个已更新，1 个取不到价"
}
```

- 没有持仓时：`total: 0` + `message: "没有活跃持仓，无需刷新行情"`
- `network: false` 时：`results: []`、`fx: {}`、`fxSource: "none"`、`message: "行情接口连不上，稍后再试"`
- `quoteDate` 是**行情自带**的日期，不是刷新时刻（非交易日不会伪装成“今天”）

> **Deferred（已知，本轮不改）**：`network: false` 仍不区分「接口连不上」「限流」「一个代码都不认」，
> 三者都回同一句 `行情接口连不上，稍后再试` —— 这是**既有 message**，按约束不动。
> 服务端已经能分辨（`QuoteFetchError.kind` → `quote-acquisition` 的 `degraded.code`，
> 并已写进 `app_logs`），把分类换算成用户可见的差异文案属于契约变更，另排。

---

## 9. 目标 `/api/goals/*`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/goals` | 目标列表 |
| POST | `/api/goals` | 创建 `{ name, type, target_amount, deadline, priority, linked_account_id, monthly_contribution }` |
| PUT | `/api/goals/:id` | 更新 |
| DELETE | `/api/goals/:id` | 删除 |
| POST | `/api/goals/:id/progress` | 记录进度 `{ amount, snapshot_date }` |
| GET | `/api/goals/:id/progress` | 进度历史 |

`type`: `saving | debt_payoff | investment | custom`
`status`: `active | completed | paused | abandoned`

---

## 10. 订阅 `/api/subscriptions/*`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/subscriptions?status=active` | 列表 + 月/年总费用 |
| POST | `/api/subscriptions` | 创建 `{ name, amount, cycle, category_id, account_id, start_date, next_payment_date, reminder_days, auto_record }` |
| PUT | `/api/subscriptions/:id` | 更新 |
| DELETE | `/api/subscriptions/:id` | 删除 |
| POST | `/api/subscriptions/:id/cancel` | 取消订阅（`status=cancelled`） |
| POST | `/api/subscriptions/:id/renew` | 恢复订阅 |

`cycle`: `monthly | quarterly | yearly`

`next_payment_date` 从 `start_date` 起按 `cycle` 推进，取**第一个晚于今天的**日期。
日号**钳位到目标月最后一天**（`monthOffsetFrom`）：`2026-01-31` +1 月 → `2026-02-28`
（闰年 `2024-01-31` → `2024-02-29`），**不会**溢出成 3 月初，也不会逐月漂移。
钳位是 clamp-and-keep（月末不回弹到原始日）——与主流计费系统一致。

`start_date` 的格式对但取值非法（如 `2026-13-01`、`2026-02-30`）会被拒在格式校验之外，
不进入 `next_payment_date`。

> `auto_record: true` 且 `account_id` 指向**停用账户**的订阅到期时会被跳过
> （不记账、不改余额、**不推进** `next_payment_date`，并打 warn 日志）；
> 还原账户后下个周期补记恰好一期。见 `DATA.md` §12。

---

## 11. 通知规则 `/api/config/notification-rules` `/api/admin/notification-rules/*`

### GET `/api/config/notification-rules`
**无需认证**。客户端启动时/定时拉取。支持 ETag/304 缓存。
```
GET /api/config/notification-rules
If-None-Match: "ab12…"
```
返回 `{ version, content_hash, updated_at, rules: { nls, a11y, sms, source_mapping, processor, precheck } }`。
- **`ETag = "<content_hash>"`**（不再绑手填的 `version`）：内容真源是仓库文件
  `server/config/rules.json`，启动时校验并发布，规则内容或代码判决据（`precheck` 由
  `ai/verify.ts` 派生注入）变化都会换 hash → 客户端凭 304 自动重拉。详见
  [ARCHITECTURE.md §3.7](ARCHITECTURE.md) 与 [recognition-flow.md §3/§9](recognition-flow.md)。
- `rules.precheck`：服务端预筛判据（`rule_id = precheck. + 服务端 reason`，可被客户端在**发请求前**
  复现）；`testcases` **不在下发 payload 内**。

### POST `/api/admin/notification-rules`
**需要 admin**。创建新版本规则。

### GET `/api/admin/notification-rules`
**需要 admin**。列出所有版本。

### PUT `/api/admin/notification-rules/:id/activate`
**需要 admin**。激活指定版本（自动停用其他）。

---

## 12. 管理员 `/api/admin/*` & `/api/settings`

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/admin/invite-codes` | 生成 `{ max_uses, expires_at }` |
| GET | `/api/admin/invite-codes` | 列出所有邀请码 |
| DELETE | `/api/admin/invite-codes/:id` | 作废（max_uses = used_count） |
| GET | `/api/admin/users` | 用户列表（**不返回**交易金额） |
| PUT | `/api/admin/users/:id` | 启用/禁用 `{ is_active: 0 }` |
| GET | `/api/admin/users/:id/stats` | 单用户统计（笔数/总额） |
| GET | `/api/admin/users/:id/transactions` | 单用户交易明细（管理员可在管理面板查看，运维排障用途，**访问写审计日志**） |
| PUT | `/api/admin/users/:id/reset-password` | 重置密码（同时撤销该用户所有 token） |
| DELETE | `/api/admin/users/:id` | 删除用户（**硬删 + 撤销该用户所有 token**） |
| GET | `/api/admin/settings` | 全局设置（Key 脱敏） |
| PUT | `/api/admin/settings` | 更新白名单全局设置 |
| GET | `/api/admin/ai-parse-stats` | AI 解析总览（成功率/修正率/P95） |
| GET | `/api/admin/ai-parse-logs` | 解析日志分页（**返回用户原始输入 `raw_input`**，访问写审计日志） |
| GET | `/api/admin/ai-parse-logs/:id` | 单条日志（含 `raw_input` 原文，访问写审计日志） |
| GET | `/api/admin/logs` | 应用日志分页 |
| GET | `/api/admin/filter-stats` | 客户端拦截计数 vs 服务端**入站** reason 对照（`?days=30`；不含用户内容；**不返回误杀率**——那要靠语料判定） |

> 隐私口径：**用户之间完全隔离**。管理员默认只在管理面板做用户/系统管理；
> 跨用户查看流水明细与解析原文属**排障用途**，服务端会写审计日志
> （`app_logs`，`level=warn`，记录操作者 admin id 与目标 user_id / log id）。
> 详见 [PRODUCT.md §1.2](PRODUCT.md)、[DEVELOPMENT.md §5.3](DEVELOPMENT.md)。

---

## 13. 应用更新 `/api/app/update` `/api/admin/updates`（Android APK 自托管分发）

### GET `/api/app/update`
**无需认证**（Android 启动时检查更新）。查询参数 `versionCode`（当前版本）。
返回是否有新版本、下载地址、是否强制更新。服务端无激活版本时返回 `has_update=false`，
客户端回落到 GitHub Release。

### POST `/api/admin/updates`
**需要 admin**。multipart 上传 APK（`apk_file`）+ 版本信息，上传后即激活（旧版本自动失活）。

### GET `/api/admin/updates`
**需要 admin**。历史版本列表（分页，`page` / `page_size`，每页默认 20 最大 100）。

---

## 14. 健康检查

### GET `/health`
无需认证。仅探活，不检查 DB / AI 可达性。
```json
{ "status": "ok" }
```

---

## 附录 A：模块-端点索引

与 `scripts/gen-api-docs.ts` 的输出**逐条对齐**（17 个模块 / 90 个端点）。

| 模块 | 端点数 | 关键端点 |
|------|--------|---------|
| auth | 4 | register, login, me, password |
| transaction | 9 | CRUD + trash + tags + permanent |
| account | 5 | CRUD + restore |
| category | 4 | CRUD |
| assets | 4 | overview, **portfolio**, snapshots, accounts（trend / snapshot 已删） |
| investments | 5 | 持仓 CRUD + quotes/refresh |
| stats | 5 | summary, by-category, trend, dashboard, analysis |
| ai | 6 | parse, chat, sessions, parse-feedback, **filter-report** |
| memory | 4 | CRUD |
| budget | 4 | CRUD |
| goals | 6 | CRUD + progress |
| subscription | 6 | CRUD + cancel, renew |
| import | 1 | CSV 预览 |
| export | 2 | JSON, CSV |
| admin | 18 | invites / users / settings / ai-stats / logs / **filter-stats** |
| app-update | 3 | update, updates |
| notification-rules | 4 | config + admin |

> `/health` 不在 `routes/` 里注册，故不计入上表的 90 个端点。
> 上表若与 `gen-api-docs.ts` 输出不一致，**以脚本为准**（它直接读 `routes/*.ts`）。

## 附录 B：自动生成脚本

`scripts/gen-api-docs.ts` 从 `routes/*.ts` 解析 `app.get/post/put/delete` 调用生成端点表。
在**仓库根目录**运行：`npx tsx scripts/gen-api-docs.ts`。CI 可选运行。
