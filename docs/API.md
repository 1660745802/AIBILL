# AI 记账 API 文档

> Base URL: `http(s)://<host>:3000/api`  
> 认证方式: `Authorization: Bearer <jwt>`  
> 响应格式: `{ "code": 0, "data": <T>, "message": "" }`

---

## 通用规则

| 项 | 说明 |
|----|------|
| 金额单位 | **整数，单位：分**。¥32.50 传 3250 |
| 日期格式 | `YYYY-MM-DD` 字符串 |
| 时间格式 | `HH:mm` 字符串 |
| 列表响应 | `data.items` 数组 |
| 分页参数 | `page`（从1开始）、`page_size`（默认20，最大100） |
| 幂等 | POST /transactions 通过 `client_id` 去重 |

---

## 错误处理

### HTTP 状态码

| Status | 含义 |
|--------|------|
| 200 | 成功（检查 body.code） |
| 400 | 参数错误 |
| 401 | 未认证/Token过期 |
| 403 | 权限不足（需 admin） |
| 404 | 资源不存在 |
| 502/504 | AI 服务异常 |

### 业务错误码

| code | 含义 |
|------|------|
| 0 | 成功 |
| 1001 | 未提供 Token |
| 1002 | Token 无效/过期 |
| 1003 | 权限不足 |
| 1004 | 用户名或密码错误 |
| 1005 | 账号已禁用 |
| 1007 | 当前密码错误（修改密码时） |
| 2000 | 参数校验失败 |
| 2001 | 邀请码无效/过期/用完 |
| 2002 | 用户名已存在 |
| 2003 | 业务校验失败 |
| 3001 | 唯一约束冲突 |
| 3002 | 资源不存在 |
| 3003 | 不能操作自己（如禁用自己） |
| 5001 | AI 解析失败 |
| 5002 | AI 响应格式异常 |
| 5003 | AI 问答失败 |

---

## 一、认证

### POST /auth/register

无需认证。

```json
// Request
{
  "username": "zhangsan",       // 3-20字符，字母数字下划线
  "password": "123456",         // 6-50字符
  "invite_code": "ABC12345",    // 必填
  "nickname": "张三"            // 可选，最多20字符
}

// Response 200
{
  "code": 0,
  "data": {
    "token": "eyJhbGci...",
    "user": { "id": 1, "username": "zhangsan", "nickname": "张三", "role": "user" }
  },
  "message": ""
}
```

### POST /auth/login

无需认证。

```json
// Request
{ "username": "zhangsan", "password": "123456" }

// Response 200
{
  "code": 0,
  "data": {
    "token": "eyJhbGci...",
    "user": { "id": 1, "username": "zhangsan", "nickname": "张三", "role": "user" }
  },
  "message": ""
}

// Response 401（密码错误）
{ "code": 1004, "data": null, "message": "用户名或密码错误" }
```

### GET /auth/me

```json
// Response 200
{
  "code": 0,
  "data": { "user": { "id": 1, "username": "zhangsan", "nickname": "张三", "role": "user" } },
  "message": ""
}
```

### PUT /auth/password

```json
// Request
{ "old_password": "123456", "new_password": "newpass123" }

// Response 200
{ "code": 0, "data": null, "message": "密码修改成功" }

// Response 400（旧密码错误）
{ "code": 1007, "data": null, "message": "当前密码错误" }
```

---

## 二、交易

### POST /transactions

批量创建，支持幂等。

```json
// Request
{
  "items": [
    {
      "client_id": "550e8400-e29b-41d4-a716-446655440000",  // UUID，幂等键
      "client_type": "web",              // web | app_android | app_ios | import_script
      "source": "ai",                    // manual | ai | import_csv | app_notification | ocr | subscription
      "source_detail": "午饭32",         // 可选，原始来源文本
      "type": "expense",                 // expense | income | transfer
      "amount": 3200,                    // 必填，分，正整数
      "category_id": 1,                  // transfer 时为 null
      "account_id": 1,                   // 可选
      "target_account_id": null,         // 仅 transfer 时必填
      "description": "午饭",            // 可选，最多200字符
      "date": "2026-07-02",             // 必填 YYYY-MM-DD
      "time": "12:30",                  // 可选 HH:mm
      "tags": ["工作日"],               // 可选
      "client_created_at": "2026-07-02T12:30:00+08:00",  // 可选，离线记账本地时间
      "ai_raw_input": "午饭32"          // 可选，AI记账原始输入
    }
  ]
}

// Response 200
{
  "code": 0,
  "data": {
    "created": [{ "id": 1, "client_id": "550e...", "type": "expense", "amount": 3200, ... }],
    "duplicates": []
  },
  "message": ""
}
```

**幂等规则**：同一 `user_id + client_id` 重复提交 → 不入库，返回在 `duplicates` 中。

### GET /transactions

```
GET /transactions?page=1&page_size=20&start_date=2026-07-01&end_date=2026-07-31&type=expense&category_id=1&account_id=1&keyword=午饭
```

所有参数可选。

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 1,
        "user_id": 1,
        "type": "expense",
        "amount": 3200,
        "category_id": 1,
        "category_name": "餐饮",
        "category_icon": "🍜",
        "account_id": 1,
        "account_name": "微信",
        "target_account_id": null,
        "target_account_name": null,
        "description": "午饭",
        "date": "2026-07-02",
        "time": "12:30",
        "tags": "[\"工作日\"]",
        "source": "ai",
        "client_id": "550e...",
        "created_at": "2026-07-02 04:30:00",
        "updated_at": "2026-07-02 04:30:00"
      }
    ],
    "total": 156,
    "page": 1,
    "page_size": 20
  },
  "message": ""
}
```

### GET /transactions/:id

单条详情，字段同列表 item。

### PUT /transactions/:id

```json
// Request（只传需要修改的字段）
{
  "amount": 3500,
  "description": "午饭加饮料",
  "category_id": 1
}

// Response 200
{ "code": 0, "data": { "id": 1, ... }, "message": "" }
```

### DELETE /transactions/:id

软删除（设置 deleted_at），可在回收站恢复。

```json
// Response 200
{ "code": 0, "data": null, "message": "交易已删除" }
```

### GET /transactions/trash

已删除的交易列表。

```json
// Response 200
{ "code": 0, "data": { "items": [...], "total": 5 }, "message": "" }
```

### POST /transactions/:id/restore

恢复已删除交易。

```json
// Response 200
{ "code": 0, "data": null, "message": "已恢复" }
```

### DELETE /transactions/:id/permanent

永久物理删除，不可恢复。

```json
// Response 200
{ "code": 0, "data": null, "message": "已永久删除" }
```

---

## 三、AI

### POST /ai/parse

自然语言 → 结构化记账数据。

```json
// Request
{ "input": "午饭32，打车15" }

// Response 200（成功）
{
  "code": 0,
  "data": {
    "items": [
      {
        "type": "expense",
        "amount": 3200,
        "category_id": 1,
        "category_name": "餐饮",
        "category_icon": "🍜",
        "description": "午饭",
        "date": "2026-07-02",
        "account_id": null,
        "account_name": "",
        "target_account_id": null,
        "target_account_name": ""
      },
      {
        "type": "expense",
        "amount": 1500,
        "category_id": 2,
        "category_name": "交通",
        "category_icon": "🚗",
        "description": "打车",
        "date": "2026-07-02",
        "account_id": null,
        "account_name": "",
        "target_account_id": null,
        "target_account_name": ""
      }
    ],
    "raw_input": "午饭32，打车15"
  },
  "message": ""
}

// Response 200（解析失败，需切手动）
{ "code": 5001, "data": null, "message": "AI 无法解析，请尝试手动记账", "fallback": "manual", "raw_input": "..." }

// Response 502（AI 超时）
{ "code": 5001, "data": null, "message": "AI 响应超时（10秒）", "fallback": "manual", "raw_input": "..." }
```

### POST /ai/chat

智能问答，基于用户财务数据回答。

```json
// Request
{ "message": "这个月花了多少？", "session_id": "abc-123-or-null" }

// Response 200
{
  "code": 0,
  "data": {
    "message": "本月总支出 ¥3,280.00，其中餐饮占比最高（45%）...",
    "session_id": "abc-123"
  },
  "message": ""
}
```

### GET /ai/sessions

对话列表。

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      { "session_id": "abc-123", "first_message": "这个月花了多少", "last_at": "2026-07-02 12:00:00", "message_count": 4 }
    ]
  },
  "message": ""
}
```

### DELETE /ai/sessions/:session_id

删除对话。

---

## 四、分类

### GET /categories

```
GET /categories?type=expense&include_inactive=1
```

参数可选。

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      { "id": 1, "user_id": 1, "name": "餐饮", "type": "expense", "icon": "🍜", "parent_id": null, "sort_order": 1, "is_active": 1 }
    ]
  },
  "message": ""
}
```

### POST /categories

```json
// Request
{ "name": "宠物", "type": "expense", "icon": "🐱", "sort_order": 12 }
```

### PUT /categories/:id

```json
// Request
{ "name": "新名称", "icon": "🐶", "sort_order": 5, "is_active": 0 }
```

### DELETE /categories/:id

停用分类（is_active = 0），不物理删除。

---

## 五、账户

### GET /accounts

```
GET /accounts?include_inactive=1
```

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 1, "user_id": 1, "name": "微信", "type": "wechat", "icon": "💚",
        "initial_balance": 0, "sort_order": 1, "is_active": 1,
        "current_balance": 1150000
      }
    ]
  },
  "message": ""
}
```

`current_balance` 由后端实时计算：`initial_balance + income - expense + transfer_in - transfer_out`

### POST /accounts

```json
// Request
{ "name": "信用卡", "type": "credit", "icon": "💳", "initial_balance": -500000, "sort_order": 5 }
```

type 枚举：`cash | wechat | alipay | bank | credit | other`

### PUT /accounts/:id

```json
// Request（只传需要修改的字段）
{
  "name": "招行卡",
  "icon": "🏦",
  "current_balance": 500000   // 设置目标余额（分），后端自动反算，显示即为此值
}
```

| 字段 | 说明 |
|------|------|
| current_balance | **推荐**。设置目标余额，后端反算 initial_balance，使显示余额 = 你设的值。后续新账单在此基础上增减 |
| initial_balance | 兼容保留。直接设底层初始值（不推荐，设了之后流水还会叠加） |

两个字段二选一传，优先 `current_balance`。

### DELETE /accounts/:id

停用账户（is_active = 0）。

---

## 六、统计

### GET /stats/summary

```
GET /stats/summary?year=2026&month=7
```

参数可选，默认当月。

```json
// Response 200
{
  "code": 0,
  "data": {
    "year": 2026,
    "month": 7,
    "expense": 328000,
    "income": 1200000,
    "balance": 872000,
    "expense_count": 45,
    "income_count": 3,
    "prev_expense": 284000,
    "prev_income": 1200000,
    "expense_change": 15,
    "income_change": 0
  },
  "message": ""
}
```

`expense_change` / `income_change`：环比百分比（整数），可能为 `null`（上月无数据）。

### GET /stats/by-category

```
GET /stats/by-category?year=2026&month=7&type=expense
```

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      { "id": 1, "name": "餐饮", "icon": "🍜", "total": 150000, "count": 20, "percent": 45.7 }
    ],
    "total": 328000,
    "year": 2026,
    "month": 7,
    "type": "expense"
  },
  "message": ""
}
```

### GET /stats/trend

```
GET /stats/trend?year=2026&month=7&period=daily&type=expense
```

period: `daily`（指定月每天）| `monthly`（最近12个月）

```json
// Response 200（daily）
{
  "code": 0,
  "data": {
    "items": [
      { "date": "2026-07-01", "total": 12000, "count": 3 },
      { "date": "2026-07-02", "total": 8500, "count": 2 },
      { "date": "2026-07-03", "total": 0, "count": 0 }
    ],
    "period": "daily",
    "type": "expense",
    "year": 2026,
    "month": 7
  },
  "message": ""
}

// Response 200（monthly）
{
  "code": 0,
  "data": {
    "items": [
      { "month": "2025-08", "total": 280000, "count": 40 },
      { "month": "2025-09", "total": 310000, "count": 45 }
    ],
    "period": "monthly",
    "type": "expense"
  },
  "message": ""
}
```

daily 模式会补全当月所有日期（无数据的天 total=0）。

---

## 七、预算

### GET /budgets

```
GET /budgets?year=2026&month=7
```

```json
// Response 200
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 1,
        "user_id": 1,
        "category_id": 0,
        "category_name": "总预算",
        "category_icon": "💰",
        "amount": 500000,
        "period": "monthly",
        "year": 2026,
        "month": 7,
        "spent": 328000,
        "percent": 66,
        "status": "normal",
        "remaining": 172000
      }
    ],
    "year": 2026,
    "month": 7
  },
  "message": ""
}
```

| 字段 | 说明 |
|------|------|
| category_id | 0 = 总预算，>0 = 分类预算 |
| spent | 当月已花费（分），后端自动计算 |
| percent | 使用百分比（整数） |
| status | `normal`(<80%) / `warning`(80-100%) / `exceeded`(>100%) |
| remaining | 剩余可用（分），超支时为 0 |

### POST /budgets

```json
// Request
{ "category_id": 0, "amount": 500000, "period": "monthly", "year": 2026, "month": 7 }

// 同一 user + category_id + year + month 自动 UPSERT
```

### PUT /budgets/:id

```json
{ "amount": 600000 }
```

### DELETE /budgets/:id

---

## 八、导入

### POST /import/csv

前端读取 CSV 文件内容后传入。返回解析结果供预览，**不直接入库**。

```json
// Request
{ "content": "CSV文件全部文本内容...", "source": "wechat" }

// source 枚举：wechat | alipay

// Response 200
{
  "code": 0,
  "data": {
    "parsed": [
      { "type": "expense", "amount": 3200, "description": "沙县小吃", "date": "2026-07-01", "source_detail": "原始行内容" }
    ],
    "total": 50,
    "skipped": 3,
    "errors": 1
  },
  "message": ""
}
```

确认导入时，客户端将 `parsed` 数组组装为 POST /transactions 的 items 提交。

---

## 九、导出

### GET /export/json

返回 JSON 文件下载（Content-Disposition: attachment）。

包含用户全部数据：transactions + categories + accounts + budgets。

### GET /export/csv

```
GET /export/csv?start_date=2026-07-01&end_date=2026-07-31
```

返回 CSV 文件下载。列：日期,类型,金额(元),分类,账户,描述。UTF-8 BOM 编码（Excel 兼容）。

---

## 十、用户设置

### GET /settings

返回合并后的设置（全局 + 用户级覆盖）。普通用户看不到 AI Key。

```json
// Response 200
{
  "code": 0,
  "data": {
    "ai_base_url": "https://api.openai.com/v1",
    "ai_model": "gpt-4o-mini",
    "currency": "CNY",
    "default_account_id": "1"
  },
  "message": ""
}
```

### PUT /settings

```json
// Request（只允许 default_account_id / theme / ai_model）
{ "default_account_id": "2" }
```

---

## 十一、管理员接口（需 admin 角色）

### POST /admin/invite-codes

```json
// Request
{ "max_uses": 5, "expires_at": "2026-12-31" }

// expires_at 可选，null = 永不过期
```

### GET /admin/invite-codes

```json
// Response
{
  "code": 0,
  "data": {
    "items": [
      { "id": 1, "code": "ABC12345", "max_uses": 5, "used_count": 2, "created_by": 1, "expires_at": null, "created_at": "..." }
    ]
  }
}
```

### DELETE /admin/invite-codes/:id

作废邀请码（将 max_uses 设为 used_count）。

### GET /admin/users

```json
// Response
{
  "code": 0,
  "data": {
    "items": [
      { "id": 1, "username": "admin", "nickname": "管理员", "role": "admin", "is_active": 1, "created_at": "...", "transaction_count": 156 }
    ]
  }
}
```

### PUT /admin/users/:id

```json
{ "is_active": 0 }   // 禁用用户
```

### GET /admin/settings

返回全局设置（AI Key 脱敏显示前8位 + ***）。

### PUT /admin/settings

```json
{ "ai_base_url": "...", "ai_api_key": "sk-...", "ai_model": "gpt-4o" }
```

白名单字段：ai_base_url / ai_api_key / ai_model / ai_temperature_parse / ai_temperature_chat / currency

---

## 十二、健康检查

### GET /health

无需认证。

```json
{ "status": "ok" }
```
