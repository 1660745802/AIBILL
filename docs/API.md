# API 接口文档

> **Base URL**: `http(s)://<host>:3000/api`
> **认证**: 除 `/health`、`/api/auth/*`、`/api/config/notification-rules`、`/api/app/update` 外均需 `Authorization: Bearer <jwt>`
> **响应格式**: 统一 `{ code: 0, data: <T>, message: "" }`
> **路由**: 见 `server/src/routes/*.ts`。本文档逐条枚举全部 90 个端点；
> 若与 `scripts/gen-api-docs.ts` 输出不一致，**以脚本为准**（它直接读 `routes/*.ts`）。

> ⚠️ **已废弃接口（deprecated，2026-10）**：`/api/budgets/*`、`/api/goals/*`、
> `/api/subscriptions/*`、`/api/memories/*`（`/api/assets/snapshot`、`/api/assets/trend` 路由已删）。
> **权威说明、判定依据与「表可否删」见 README.md「功能现状」**（唯一真源，此处不再重复）。
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
入参/出参扩展、跨端约定）见 本文件附录 C §1/§5/§6**；此处只列要点：
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
  本文件附录 C §4。

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
  [ARCHITECTURE.md §3.7](ARCHITECTURE.md) 与 本文件附录 C §3/§9。
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
> 详见 README.md「定位与原则」、[ARCHITECTURE.md §5.3](ARCHITECTURE.md)。

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

---

## 附录 C：跨端解析契约（服务端 ⇄ Android）

> 与 Android 客户端共享的接口契约。**内部小节编号沿用 §0–§11**（本附录里出现的 `§N` 均指本附录内的小节，
> 与 API.md 正文的章节号无关）。与 Android 侧共享的是本附录的**导出件**，放在两边约定的共享目录
> （开发阶段临时件，专项结束后删除，不进仓库）。

> 双边共享，**改契约先改这里**。实现真源（服务端）：`routes/ai.ts`、`ai/prompts.ts`、`ai/verify.ts`、
> `lib/parse-filter.ts`、`routes/notification-rules.ts`、`db/schema.ts`。状态：v1（2026-10）。

## 0. 术语与字段命名（先定名，避免同义两套）
| 名 | 含义 |
|---|---|
| tier | `classifyNotification` 档位：0 强/弱噪声、1 金额+动词、2 仅金额、3 仅动词、4 无信号 |
| 入站预筛 | tier 0/4 → **不调模型**；出站佐证 = tier 2/3 的模型结果需过 `verifyParsed` |
| `channel` | **入口归因**：`nls`｜`sms`｜`a11y`｜`manual`；`input` = 解析正文（唯一必填） |
| `source` | **来源应用**：`{ package_name, source_name? }`。⚠️ 不要用它表示入口，会和 `channel` 撞名 |

## 1. `POST /api/ai/parse` 响应有 8 种形态（客户端必须按形态分支）
请求：`{ input: string(1..3000) }`（扩展见 §5）。限流 20/min。

| # | 触发 | HTTP | code | data | parse_log_id |
|---|---|---|---|---|---|
| 1 | 入站预筛挡下 | 200 | 0 | `{items:[], raw_input, source:'prefilter'}` | 无 |
| 2 | 快捷正则解析 | 200 | 0 | `{items, raw_input, parse_log_id, source:'quick'}` | `data` |
| 3 | 出站判定为噪声 | 200 | 0 | `{items:[], raw_input, source:'postfilter'}` | 无 |
| 4 | 模型解析成功 | 200 | 0 | `{items, raw_input, parse_log_id}` | `data`（`source` 缺失，§6 补 `'ai'`） |
| 5 | 模型空结果 | 200 | 5001 | `null`（`fallback:'manual'`） | **顶层** |
| 6 | AI 超时 / 上游错误 | 504 / 502 | 5001 | `null`（`fallback:'manual'`） | 无 |
| 7 | 响应格式异常 | 200 | 5002 | `null`（`fallback:'manual'`） | 无 |
| 8 | 入参校验失败 | 400 | 2000 | `null` | 无 |

- ⚠️ #1/#3/#6/#7 **没有 parse_log_id**（无 `ai_parse_logs` 行）→ **不存在可反馈对象**，不要回传；判失败要看 `code`/`fallback`，**别只看 HTTP**（#5/#7 是 200）。

## 2. 反馈闭环（Q1）—— 双方优先做，服务端已确认可做
`POST /api/ai/parse-feedback`（认证）：
```jsonc
{
  "parse_log_id": 123,      // §1 取得（data 或顶层）
  "final_items": [ /* 用户确认后的**最终态**数组，元素同 parse items 形状 */ ],
  "modified": true,         // 与 AI 原始是否不同（服务端只信这个布尔，不自行 diff）
  "channel": "nls"          // 可选归因（见 §0）
}
```
- **客户端传「用户改后的 items」**（最终态），不是 AI 原始、不是补丁：**删除整笔 = 该项不在 `final_items` 里**，新增 = 多出的项，改字段 = 直接是新值；`modified=false` + 传 items 也接受（语义：确认无误）。
- 响应 `{code:0,data:null}`；记录不存在/不属于当前用户 → 404 `3002`。
- 服务端行为：写 `ai_parse_logs.final_items / user_modified / modification_detail`；`modified=true` 时
  尝试自动学习 `ai_memories(source='ai_suggested')`（**不会**注入 prompt，防自我污染）。
- ⚠️ **服务端先修**：自动学习按 **index 配对**（`Math.min(original.length, final.length)`），
  条数不等（删/增）时会**错配并学到错误记忆**。修法：条数不等时不学习。

## 3. 规则同源下发（Q2）—— ④ 与 ⑤ **必须同批做**
- **不做映射表**（客户端已证伪）：客户端预筛是**另一套分类学**（自身通知/系统分组摘要/日报汇总/单包熔断/DB 去重），服务端是 tier 档位链；强行映射只会得到**第三种口径**。所以先做 ④（下发服务端判据），客户端命中即用**同一 `rule_id`** 计数 → ⑤ 天然同口径。
- 客户端**独有**的拦截用 `client_only.<name>` 上报，**明确标注「服务端无对应判据」、不参与误杀率比较**。
- `precheck` **由 `ai/verify.ts` 常量在发布时派生注入**（**不写在 rules.json 里**，避免手抄漂移）；`content_hash` 覆盖**已发布 payload（含 precheck）** → 代码里改判据也会换 hash、客户端会重拉。
- ⚠️ 本判据 **channel 无关**（服务端不分区 nls/sms/a11y）；客户端可在其之前先做自己的渠道门禁（那些计入 `client_only.*`）。⚠️ 因此 `a11y/sms` 词表（渠道门禁）与 `STRONG_NOISE/WEAK_NOISE`（服务端判据）是**两个层次**，重叠词条不是 bug；新增词条时先问一句：**这是渠道门禁，还是服务端判据？**（前者进 `rules.json`，后者进 `ai/verify.ts`）。
| rule_id（稳定，跨端同名） | tier | 语义（客户端要按它计数并解释「为什么没调 AI」） |
|---|---|---|
| `precheck.strong_noise` | 0 | 纯噪声 regex 命中 → 不调模型（验证码/广告/系统提示） |
| `precheck.money_verb` | 1 | 金额 + 交易动词 → **一定**调模型 |
| `precheck.weak_noise` | 0 | 弱噪声 regex，**仅在无正向信号时**才拦（顺序即语义） |
| `precheck.money_only` | 2 | 只有金额 → 调模型，但出站需**金额佐证** |
| `precheck.bare_amount` | 2 | 短句（≤30 字）光杆数字（「午饭32」） |
| `precheck.verb_only` | 3 | 只有交易动词 |
| `precheck.no_signal` | 4 | 无任何信号 → 不调模型（兜底，排最后） |
- **已实现**（本地）：payload = `precheck{schema:1, derived_from, channel_agnostic, signals{money{pattern,flags},verb{pattern,flags},bare_amount{pattern,flags},bare_amount_max_len:30}, rules[14 条], should_call_ai:"tier in (1,2,3)", corroboration_required:"tier in (2,3)"}`；`schema` 不认识 → 整体忽略并降级用本地词表。**`rule_id = 'precheck.' + 服务端 reason`（逐字拼接，`+` 也不改名）**→ ⑤ 对账是机械前缀剥离，不是映射表。
- **拦不拦怎么判（客户端勿猜）**：按 `rules[]` **顺序取第一条命中**，只看它的 `tier`：`tier ∈ {1,2,3}` = 放行去调模型（即 `should_call_ai`），`tier ∈ {0,4}` = 拦。⚠️ **没有 `tier:null` 的条目**（早期草案里的 `precheck.payment_verb` 已删除）；`type:'predicate'` 用 `expr` 引用 `signals`，`type:'fallback'` 是兜底（排最后）。`pattern` 是**不含分隔符的正则源码**，必须与同条 `flags` 一起编译（仅允许 `g`/`i`/`m`；**`money` 是 `gi`**——丢了会让 `rmb 100` 两端不一致）。
- **`bare_amount_max_len` 精确定义**：取客户端发来的 `input` **原串**（不是 title/body），`input.trim().length <= 30`；长度按 **UTF-16 code unit** 计（中文=1、emoji=2）——**Kotlin `String.length` 同口径**，直接可比。
- **`expr` 语法边界（客户端按封闭小语法实现，不要写表达式解析器）**：只允许三种形态——`signal`、`signal && signal`、`len<=<int> && signal`（`signal` 必须是 `signals` 的键；分隔符统一为**前后各一个空格**的 ` && `）。**其余形态客户端必须忽略该条规则 + 记日志 + 计入 `precheck_unknown_expr`**（fail-safe：绝不当成「命中」或「不命中」来猜）。服务端用回归用例保证只产出上述三种（并校验引用的 signal 存在）；将来要扩形态必须**先改本契约并播报**。
- **只覆盖入站**：`precheck` 是「调模型之前」的判据；出站佐证（`verifyParsed` 的 drop 理由）在模型调用后才产生，客户端算不出来，故不在清单、也不参与 ⑤ 对比。
- ⚠️ 正则交集子集（**本轮修正**）：**允许有界 lookaround**（单字符类，如 `(?<![\d.])`、`(?!\d)`——服务端自己的判据就在用，且 Java 的定长 lookbehind 能表达）；**禁变长 lookbehind**（`(?<=a+)`，JVM 编译不过）/ 命名组 / `\p{}` / possessive / 内联 flags。服务端**启动时校验**，且**派生出的正则自己先过一遍**（有回归用例自证）。文件与 admin POST **两条发布路径都注入 precheck**（否则激活 admin 版本会让客户端丢掉整个判据）；文件里手写 `precheck` 直接 400。
- ⚠️ **判据必须自足**：`signals.*.pattern` / `rules[].pattern` **不得依赖任何未写进本契约的文本预处理**——客户端拿到的 pattern 就是完整规格，不需要自己加任何归一化步骤。
  - 反面案例（真实发生过）：`money` 曾依赖服务端内部「先剥掉千分位逗号」这一步，而它**没写进契约** → 同一段 `…支出(跨行汇款)1,000元，余额24,210.99元。` 服务端判 `money+verb`(tier1)、客户端判 `verb_only`(tier3)，**两端计数不可比**（换条文本就可能变成 P0 误杀）。形态与 `gi` 丢标志那次同源：判据依赖了隐式输入预处理。
  - 现口径：`money` 的 pattern **自己吞千分位**（`\d{1,3}(?:,\d{3})+` 支路），客户端**不做任何预处理**：`1,000元` ✓ / `24,210.99元` ✓ / `¥1,000.50` ✓；畸形分组（`1,23元`、`2.555元`）两端都**不**当金额。
  - 护栏：服务端 `tests/lib/precheck-selfsufficient.test.ts` 用**只吃载荷**的参考求值器逐条对齐 `classifyNotification`（含「把 pattern 换回旧形式必红」的鉴别力自检）；新加/改任何判据都要过它。

## 4. 拦截计数上报（Q3）—— **已实现**（`POST /api/ai/filter-report`，认证，限流 20/min）
- **不复用 `ai_parse_filters`**：那张表是「服务端挡了哪些」的**逐条事件**（DATA §10.4）；客户端上报是按窗口**聚合计数**且带客户端维度，混在一起「服务端 53%」就不可比。新表 `client_filter_stats` + `client_filter_totals`（migration021）。
- 请求：`{window_start, window_end, client_version, channel, counts:[{rule_id,count}], totals:{notifications,blocked}}`。`channel` **必填**（nls|sms|a11y|manual）且**进幂等键**（SQLite 唯一索引里 NULL 互不相等，允许 NULL 会让重复上报变多行）。
- **窗口**：可解析、`start<=end`、跨度 ≤31 天；**无时区串按北京时间解释**（项目「今天」口径），存储与去重统一为 **UTC** `YYYY-MM-DD HH:MM:SS` → 所以 `2026-10-12T00:00:00+08:00` 与 `2026-10-12 00:00:00` 是**同一个键**。⚠️ 别用 `Date.parse` 直接归一：它对无时区串按**本机时区**解释（容器跑 UTC 就差 8h）。
- **幂等 = 覆盖**：同 (user, client_version, channel, 窗口, rule_id) 重复上报**改写** hits 而非累加 → 客户端可放心重试。
- `rule_id` 只允许 `precheck.*`（可比）或 `client_only.*`（服务端无对应，不可比）；**第三个前缀 400**。回执 `{accepted, unknown_precheck_ids}`——后者是「你的清单与我当前清单不一致」的**漂移信号**（收下但标出，不拒绝）。
- 约束：`counts` 1..200 条、`blocked <= notifications`；超限一律 400（不静默截断）。
- **admin 对照视图**：`GET /api/admin/filter-stats?days=30` → `client.by_rule[{rule_id,namespace,comparable,hits}]` + `client.by_channel/totals(block_rate)` + `server.by_reason`（**只含入站** reason，出站不在 precheck 范围）。⚠️ **不返回「误杀率」**：它必须靠语料 `expect_txn` 判定，用计数相减算出来的是编的（视图 `note` 里明说）。
- `client_only.*` = **客户端独有判据 + 诊断计数**（服务端无对应判据，**不可比**）；id 语义由**客户端维护**，此处为 2026-10 快照（`self_notification` 自身通知 · `duplicate_content` 5s 内容去重 · `blank_text` 空正文 · `system_group_summary` 系统分组摘要 · `summary_report` 日报/区间合计 · `promo_sentence` 促销句式 · `marketing` 营销词且无强交易特征 · `not_financial` 账务判据未过 · `ai_memory` 5min 长窗 · `ai_muted` 单包熔断 · `db_duplicate` 1s 去重 · `list_page` A11Y 账单/明细**列表页**（双条件：页面可见文本里金额节点 ≥3 **且**命中列表词）· **`precheck_unknown_expr` 漂移诊断，非拦截**）。
  接受诊断类条目上报（否则漂移没人看得见）：服务端只搬计数，**不维护 id→语义 映射**（映射会腐）——语义真源在客户端。
- **可选云控键**（渠道门禁调参，缺失时客户端用内置默认）：`a11y.list_page_keywords`（非空字符串数组）、
  `a11y.list_page_min_amounts`（正整数）。服务端 `validateRules` 对它们做**出现即校验类型**（缺失放行）。
  ⚠️ 服务端 `classifyNotification` **不读这两键**——它们纯属客户端渠道门禁，**不改变 `precheck.*` 判决**，
  因此 ⑤ 对账不受影响；但它们进 `content_hash`，改了会让客户端重拉（正是调参想要的）。

## 5. 入参扩展（Q4）—— 收，但 `hints` 不进 prompt
```jsonc
{ "input":"…", "channel":"nls",
  "source": {"package_name":"com.tencent.mm","source_name":"微信支付"},
  "title":"…", "body":"…", "received_at":"2026-10-12T23:40:00+08:00",
  "hints": {"amount_cents":3200,"merchant":"美团","account_name":"微信","direction":"expense"} }
```
- `input` 仍唯一必填（向后兼容）。`title`/`body` v1 **只收 + 校验 + 落库**，**暂不参与**去噪/佐证：
  body 变长会让 tier2「短句光杆数字」判据（len≤30）失效，属独立行为变更，不混做。
- `received_at` **必须带时区偏移**：服务端取它的**北京日期**作为该请求的「今天」（跨午夜迟发不写错日期）；
  越出 [今天-7, 今天+1] 则忽略并回落今天（手机时钟护栏）；锚定值在 quickParse / prompt / 校验间保持一致。
- ⚠️ `source.source_name`：服务端已有 `source_mapping`（包名→友好名）**唯一真源**；请**必发 `package_name`**，友好名可选且仅作参考。
- ⚠️ `hints` v1 **只落库、不喂 prompt**（进 prompt 会让模型抄 hint、绕过金额佐证→假账）；响应新增可选 `hints_conflict`。
  落库：`ai_parse_logs` 加 `channel/source_package/received_at/hints`，`ai_parse_filters` 加 `channel/source_package`（migration019）。

## 6. 出参扩展（Q5）—— 全部**机械推导/抽取，不进 prompt**；`method` 复用 `account`
| 字段 | 取值 | 来源（均为机械，模型不参与） |
|---|---|---|
| `source` | `quick｜ai｜prefilter｜postfilter` | 补齐 #4 缺失的 `'ai'` |
| `merchant` | string｜null | 商户关键词/描述前缀抽取（供分类预填与学习）；与 `description` 并存 |
| `order_no` / `card_tail` | string｜null | 正文正则（订单号/流水号、`尾号\d{4}`）；**不让模型复制**（纯复制必幻觉） |
| `balance_after_cents` | int｜null，**仅提示** | 正文「余额/剩余」抽取；**语义未定**（可用余额 vs 账户余额无法区分） |
| `balance_text` | string｜null | 上项命中的**原始片段**（含「可用余额」等前缀词）→ 客户端按前缀做**同模板自比** |
| `time` | `HH:mm`｜null | 正文时刻抽取；日期仍在 `date`。**已核实**与 `POST /transactions` 同格式（`^\d{2}:\d{2}$`） |
| `confidence` | `high｜medium｜low`（**枚举，非 0~1**） | 派生：quick? + 分类是否精确命中 + 金额是否有佐证 |
| `confidence_reasons` | string[] | 上述判据的机械原因（阈值可审计） |
| `needs_review` | boolean | **服务端用唯一阈值算**：`verifyParsed=review`／分类未精确命中／金额来自裸数字 |
- **客户端请用 `needs_review` 作「不自动入账」判据，不要自己对 `confidence` 设阈值**——否则又是两套阈值（本项目顽疾）；`confidence` 仅供展示/排序。
- `confidence` **不是模型自评**（模型根本不输出它），派生自 tier/quick/精确分类/金额佐证 → 语义稳定、可回归；**不要**用 0~1 浮点。
- `card_tail` 与 `balance_after_cents`/`balance_text` **必在同一 items 元素**（按元素抽取，抽不到则同为 null）。
- `hints_conflict` 只反映「客户端 hint 与文本不一致」，属 **hint 质量问题**，**不进** `needs_review`/`confidence`；客户端用作本地诊断即可，**不据此降级或拒收**（本地正则不得间接决定账目）。
- 模型只输出 `type/amount/category/description/date/account/target_account`：再加 7 个键会每次多输出约 7×N 个键，且 identifier 属纯复制（幻觉高发）→ **不加**；落库**零 migration**（`parsed_items` 等都是 JSON TEXT）。
- ⚠️ 这些是**解析元数据**不是账本字段（提交 `POST /transactions` 会被 zod 剥掉，不污染账本）；`balance_after_cents` **不得**用于写余额（唯一写入口 = 归属账单增量 + 手填覆盖，DATA §12）。

## 7. 兼容与灰度（Q6）—— 确认可行
- payload **只加键、不改既有键语义**；新增键一律可选且有默认值。
- 客户端：**未知键必须忽略**（Moshi 不要开 failOnUnknown）。
- 服务端：zod `.parse()` 会**静默剥离**入参未知键 → 客户端新增入参在服务端加字段前**不可依赖**。
- 响应无 schema 校验（加键天然向后兼容）；`client_version` **只记录与统计**、**不用它分叉行为**（不可测），能力协商用 `precheck.schema`。
- 失败语义不变：解析失败保持 200 + `5001/5002` + `fallback:'manual'`；超时 504、上游错误 502。

## 8. 相关规则的归属（**不在这里重复**）

- **规则内容真源 / 发布与回滚 / 启动 fail-fast** → [ARCHITECTURE.md §3.7](ARCHITECTURE.md)
- **客户端支持基线（≥1.5.0）与 `versionCode` 纪律** → [ARCHITECTURE.md §3.8](ARCHITECTURE.md)
- **护栏写法**（按分支枚举配「数据非空」构造、变异自检、清单按基线版本生成）→ [ARCHITECTURE.md §7.2](ARCHITECTURE.md)
- **语料形状**（`testcases` 的 `expect_tier`/`expect_txn`/`expect_reason`）由 `server/config/rules.json` 与 `lib/notification-rules.ts` 的 `validateRules` 定义。⚠️ 语料本体、本附录的共享导出件、对账 payload 都属**开发阶段产物**，专项结束后删除；**需要长期固化的语义只留在上面三处**。
