# API 接口文档

> **Base URL**: `http(s)://<host>:3000/api`
> **认证**: 除 `/health`、`/api/auth/*`、`/api/config/notification-rules` 外均需 `Authorization: Bearer <jwt>`
> **响应格式**: 统一 `{ code: 0, data: <T>, message: "" }`
> **路由总数**: 80（基于 `server/src/routes/*.ts` 2026-09 重构）

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
| 2001 | 邀请码无效/过期/用完 |
| 2002 | 用户名已存在 |
| 2003 | 业务校验失败 |
| 3001 | 唯一约束冲突 |
| 3002 | 资源不存在 |
| 3003 | 不能操作自己 |
| 5001 | AI 解析失败 |
| 5002 | AI 响应格式异常 |
| 5003 | AI 问答失败 |

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
```
改密成功后**自动撤销该用户所有现存 token**（写入 `jwt_revocations`）。

### GET `/api/settings`
返回合并后的设置（用户覆盖 > 全局）。普通用户**看不到 AI Key**。

### PUT `/api/settings`
白名单字段：`default_account_id` / `theme` / `ai_model`（覆盖全局模型）。

---

## 2. 交易 `/api/transactions/*`

### POST `/api/transactions`
**批量 + 幂等**。items 单条通用契约见 [ARCHITECTURE.md §3.4](ARCHITECTURE.md)。
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
幂等：同 `user_id + client_id` 不入库，挪到 `duplicates`。

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
**限流：20/分钟**。用户输入 `<user_input>` 包裹后送 LLM。
```json
{ "input": "午饭32，打车15" }
// Response 成功
{ "code": 0, "data": { "items": [{ "type": "expense", "amount": 3200, "category_id": 1, "category_name": "餐饮", "category_icon": "🍜", "description": "午饭", "date": "2026-07-02", "account_id": null, "account_name": "", "target_account_id": null, "target_account_name": "" }], "raw_input": "..." }, "message": "" }
// 失败 fallback
{ "code": 5001, "data": null, "message": "AI 无法解析...", "fallback": "manual", "raw_input": "..." }
```

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
| GET | 列出账户，含 `current_balance`（实时计算） |
| POST | 创建账户（`initial_balance` 可负） |
| PUT | 更新；**支持 `current_balance`**（推荐）—— 后端反算 initial_balance，使显示余额 = 你设的值 |
| DELETE | 停用 |

`account.type`: `cash | wechat | alipay | bank | credit | other`

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

### POST `/api/stats/analysis`
```json
{ "dimension": "overall | spending | forecast", "months": 4 }
// Response
{ "code": 0, "data": { "analysis": "AI 生成的报告...", "chart_data": {...} }, "message": "" }
```
服务端**单条 `GROUP BY substr(date,1,7)`** 取多个月数据。

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
{ "code": 0, "data": { "parsed": [...], "total": 50, "skipped": 3, "errors": 1 }, "message": "" }
```
**只解析不直接入库**，前端预览确认后组装 items 调 `POST /api/transactions`。

### GET `/api/export/json`
返回 JSON 文件下载（Content-Disposition: attachment）。含 transactions + categories + accounts + budgets。

### GET `/api/export/csv?start_date=&end_date=`
返回 CSV（UTF-8 BOM，Excel 兼容）。列：日期,类型,金额(元),分类,账户,描述。

---

## 8. 资产 `/api/assets/*`（财务工作台）

### GET `/api/assets/overview`
返回 `{ net_assets, total_assets, total_liabilities, distribution: [...], accounts: [...] }`。**单条聚合 SQL**（已修 N+1）。

### GET `/api/assets/trend?months=6`
净资产历史趋势（基于 `asset_snapshots`）。

### POST `/api/assets/snapshot`
手动触发月度快照。

### PUT `/api/assets/accounts/:id`
更新账户资产属性：`asset_type` / `currency` / `credit_limit` / `billing_day` / `due_day` / `note`。

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

---

## 11. 通知规则 `/api/config/notification-rules` `/api/admin/notification-rules/*`

### GET `/api/config/notification-rules`
**无需认证**。客户端启动时/定时拉取。支持 ETag/304 缓存。
```
GET /api/config/notification-rules
If-None-Match: "15"
```
返回 `{ version, updated_at, rules: { nls, a11y, sms, source_mapping, processor } }`。

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
| GET | `/api/admin/users/:id/transactions` | 单用户交易明细（**仅管理员可查明细**，不在前端 UI 暴露） |
| PUT | `/api/admin/users/:id/reset-password` | 重置密码（同时撤销该用户所有 token） |
| DELETE | `/api/admin/users/:id` | 删除用户（**硬删 + 撤销该用户所有 token**） |
| GET | `/api/admin/settings` | 全局设置（Key 脱敏） |
| PUT | `/api/admin/settings` | 更新白名单全局设置 |
| GET | `/api/admin/ai-parse-stats` | AI 解析总览（成功率/修正率/P95） |
| GET | `/api/admin/ai-parse-logs` | 解析日志分页 |
| GET | `/api/admin/ai-parse-logs/:id` | 单条日志 |
| GET | `/api/admin/logs` | 应用日志分页 |

---

## 13. 健康检查

### GET `/health`
无需认证。
```json
{ "status": "ok", "db": "ok", "ai": "ok" }
```
（增强版同时检查 DB 连接 + AI 配置可达性）

---

## 附录 A：模块-端点索引

| 模块 | 端点数 | 关键端点 |
|------|--------|---------|
| auth | 4 | register, login, me, password |
| settings | 2 | GET, PUT（用户级） |
| transactions | 9 | CRUD + trash + tags |
| ai | 5 | parse, chat, sessions, feedback |
| memories | 4 | CRUD |
| categories | 4 | CRUD |
| accounts | 4 | CRUD |
| stats | 5 | summary, by-category, trend, dashboard, analysis |
| budgets | 4 | CRUD |
| import | 1 | CSV 预览 |
| export | 2 | JSON, CSV |
| assets | 4 | overview, trend, snapshot, accounts |
| goals | 6 | CRUD + progress |
| subscriptions | 6 | CRUD + cancel, renew |
| notification-rules | 4 | config + admin |
| admin | 15 | invites/users/settings/ai/stats/logs |
| health | 1 | /health |

## 附录 B：自动生成脚本

`scripts/gen-api-docs.ts` 可从 `routes/*.ts` 解析 `app.get/post/put/delete` + zod schema 自动生成端点表。CI 可选运行。