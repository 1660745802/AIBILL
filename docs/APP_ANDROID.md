# Android App 开发指南

> 本文档为 Android 原生 App 开发提供完整的对接信息。
> Web 端代码仓库：https://github.com/1660745802/AIBILL

---

## 1. 项目概况

**AI 记账** 是一个自部署的个人财务工作台，当前已有完整的 Web 端（Vue3 PWA）和后端 API（Node.js + Fastify）。

Android App 的定位：**复用同一套后端 API**，提供原生体验 + 原生独有能力（通知监听、自动记账等）。

### 核心体验目标

| 指标 | 目标 |
|------|------|
| 打开→入账 | ≤ 3 步 |
| AI 记账耗时 | < 5 秒 |
| 离线可用 | 手动记账不依赖网络 |

---

## 2. 后端 API 契约

### 2.1 基础信息

| 项 | 值 |
|----|-----|
| Base URL | `http(s)://<server-ip>:3000/api` |
| 认证方式 | `Authorization: Bearer <jwt>` |
| Content-Type | `application/json` |
| 响应格式 | `{ code: number, data: any, message: string }` |
| 成功 code | `0` |
| Token 有效期 | 30 天 |

### 2.2 接口清单

#### 认证
```
POST /api/auth/register
  Body: { username, password, invite_code, nickname? }
  Response: { token, user: { id, username, nickname, role } }

POST /api/auth/login
  Body: { username, password }
  Response: { token, user: { id, username, nickname, role } }

GET /api/auth/me
  Response: { user: { id, username, nickname, role } }

PUT /api/auth/password
  Body: { old_password, new_password }
```

#### 交易（核心）
```
POST /api/transactions
  Body: {
    items: [{
      client_id: "uuid-v4",          // 必填，幂等键
      client_type: "app_android",     // 必填，标识来源
      source: "manual|ai|app_notification",  // 必填
      source_detail?: "原始通知文本",
      type: "expense|income|transfer",
      amount: 3200,                   // 整数，单位：分
      category_id: 1,                 // transfer 时为 null
      account_id?: 1,
      target_account_id?: 2,          // 仅 transfer 时必填
      description?: "午饭",
      date: "2026-07-01",             // YYYY-MM-DD
      time?: "12:30",                 // HH:mm
      tags?: ["标签"],
      client_created_at?: "ISO8601",  // 离线记账时的本地时间
      ai_raw_input?: "原始输入"
    }]
  }
  Response: { created: [...], duplicates: [...] }

GET /api/transactions?page=1&page_size=20&start_date=&end_date=&type=&category_id=&account_id=&keyword=
  Response: { items: [...], total, page, page_size }

GET /api/transactions/:id
PUT /api/transactions/:id
DELETE /api/transactions/:id   // 软删除
```

#### AI
```
POST /api/ai/parse
  Body: { input: "午饭32，打车15" }
  Response: {
    items: [{
      type, amount(分), category_id, category_name, category_icon,
      description, date, account_id, account_name,
      target_account_id?, target_account_name?
    }],
    raw_input
  }
  Error: { code: 5001, message: "...", fallback: "manual", raw_input }

POST /api/ai/chat
  Body: { message: "这个月花了多少？", session_id?: "uuid" }
  Response: { message: "AI回答", session_id }
```

#### 其他
```
GET    /api/categories
GET    /api/accounts
GET    /api/stats/summary?year=&month=
GET    /api/stats/by-category?year=&month=&type=expense
GET    /api/stats/trend?year=&month=&period=daily&type=expense
GET    /api/budgets?year=&month=
GET    /api/settings          // 用户设置
PUT    /api/settings          // { default_account_id, theme, ai_model }
GET    /api/export/json       // 下载全量备份
GET    /api/export/csv        // 下载流水CSV
```

### 2.3 关键规则

| 规则 | 说明 |
|------|------|
| **金额单位** | 所有金额字段以**分**为单位的整数。¥32.50 = 3200 |
| **幂等** | 同一 user_id + client_id 不会重复入库，返回已有记录 |
| **client_type** | App 端必须传 `app_android` |
| **source** | 手动记账传 `manual`，AI传 `ai`，通知自动记传 `app_notification` |
| **transfer** | 转账类型 category_id 为 null，不计入收支统计 |
| **status** | App 通知识别的交易可先以 `pending` 状态写入（预留，当前默认 confirmed） |
| **数据隔离** | 每个用户只能看到自己的数据 |
| **时区** | 日期为纯字符串 YYYY-MM-DD，由客户端决定"今天"是哪天 |

---

## 3. App 独有能力（Web 端没有）

这些是 App 开发的核心差异化：

### 3.1 通知监听自动记账

```
用户收到支付通知（微信/支付宝/银行App）
  → NotificationListenerService 捕获
  → 正则/AI 解析通知文本
  → 生成候选交易（status: pending）
  → 用户确认后改为 confirmed
```

**通知解析示例**：
```
"微信支付成功，付款￥32.00，收款方：沙县小吃"
→ { type: "expense", amount: 3200, description: "沙县小吃", account: "微信" }

"支付宝收款￥5000.00，来自张三"
→ { type: "income", amount: 500000, description: "来自张三", account: "支付宝" }
```

### 3.2 语音输入

- 集成系统语音识别 → 转文字 → 调 POST /api/ai/parse
- 首页长按录音按钮 or 语音图标

### 3.3 离线暂存 + 同步

```
离线时：
  - 手动记账存入本地 SQLite/Room
  - client_created_at 记录本地时间
  - 标记为"待同步"

联网后：
  - 批量调 POST /api/transactions
  - 利用 client_id 幂等，重试安全
  - 同步成功标记为"已同步"
```

### 3.4 桌面小组件 (Widget)

- 快速记账 Widget：点击直接打开记账输入
- 月度摘要 Widget：展示本月支出/收入/结余

### 3.5 推送提醒

- 预算超支提醒
- 每日记账提醒（可配置时间）
- 定期账单到期提醒

---

## 4. 建议技术栈

| 层 | 推荐 | 备选 |
|----|------|------|
| 语言 | Kotlin | - |
| UI | Jetpack Compose | XML Layout |
| 网络 | Retrofit + OkHttp | Ktor Client |
| 本地存储 | Room (SQLite) | DataStore |
| DI | Hilt | Koin |
| 异步 | Coroutines + Flow | RxJava |
| 图表 | MPAndroidChart / Vico | - |
| 通知监听 | NotificationListenerService | - |
| 语音 | SpeechRecognizer (系统) | - |

---

## 5. 建议页面结构

```
├── 登录/注册
├── 首页
│   ├── 月度摘要卡片
│   ├── AI 输入框 + 语音按钮
│   ├── 快捷短语
│   ├── 确认卡片
│   └── 今日流水
├── 流水列表
│   ├── 搜索筛选
│   ├── 按日分组（含日小计）
│   └── 点击编辑/左滑删除
├── 统计
│   ├── 收支摘要 + 环比
│   ├── 趋势图
│   ├── 分类饼图
│   └── 排行列表
├── AI 对话
├── 预算
├── 设置
│   ├── 账户管理
│   ├── 分类管理
│   ├── 通知监听开关
│   ├── 自动记账规则
│   ├── 数据导出
│   └── 关于
└── 通知中心（待确认交易列表）
```

---

## 6. 数据模型参考

### 本地数据库（Room）

```kotlin
// 待同步的离线交易
@Entity(tableName = "pending_transactions")
data class PendingTransaction(
    @PrimaryKey val clientId: String,    // UUID
    val type: String,                     // expense/income/transfer
    val amount: Int,                      // 分
    val categoryId: Int?,
    val accountId: Int?,
    val targetAccountId: Int?,
    val description: String?,
    val date: String,                     // YYYY-MM-DD
    val time: String?,
    val source: String,                   // manual/ai/app_notification
    val sourceDetail: String?,            // 原始通知文本
    val clientCreatedAt: String,          // ISO8601
    val syncStatus: String,              // pending/synced/failed
    val createdAt: Long
)

// 缓存的分类列表
@Entity(tableName = "categories")
data class Category(
    @PrimaryKey val id: Int,
    val name: String,
    val type: String,
    val icon: String,
    val sortOrder: Int
)

// 缓存的账户列表
@Entity(tableName = "accounts")
data class Account(
    @PrimaryKey val id: Int,
    val name: String,
    val type: String,
    val icon: String,
    val currentBalance: Int
)
```

---

## 7. 通知解析规则参考

```kotlin
// 微信支付
val WECHAT_PAY = Regex("""微信支付.*?[付款|支付].*?(\d+\.?\d*).*?[元|¥]""")
val WECHAT_RECEIVE = Regex("""微信.*?[收款|到账].*?(\d+\.?\d*).*?[元|¥]""")

// 支付宝
val ALIPAY_PAY = Regex("""支付宝.*?[付款|支付].*?(\d+\.?\d*)""")
val ALIPAY_RECEIVE = Regex("""支付宝.*?[收款|到账].*?(\d+\.?\d*)""")

// 银行短信
val BANK_EXPENSE = Regex("""[消费|支出|转出].*?(\d+\.?\d*)元""")
val BANK_INCOME = Regex("""[收入|转入|到账].*?(\d+\.?\d*)元""")
```

对于复杂通知，可调用后端 AI 解析接口辅助。

---

## 8. 注意事项

1. **金额始终用分**：App 内部存储和传输都用整数分，仅在 UI 展示时 ÷ 100
2. **client_id 必须持久化**：离线交易的 UUID 在重试时必须保持一致，才能利用幂等
3. **client_type = "app_android"**：方便后端区分来源做统计
4. **时区由客户端决定**：date 字段传本地日期字符串，不要用 UTC
5. **Token 刷新**：JWT 30 天过期，App 端建议在每次启动时检查，过期则重新登录
6. **通知权限**：NotificationListenerService 需要用户手动授权，引导页要做好
7. **后台限制**：Android 对后台服务有限制，通知监听是系统级服务不受影响，但同步任务建议用 WorkManager

---

## 9. 开发优先级建议

| 阶段 | 功能 | 说明 |
|------|------|------|
| v0.1 | 登录 + AI记账 + 手动记账 + 流水列表 | 核心闭环 |
| v0.2 | 统计 + 预算 + 离线暂存 | 可用性 |
| v0.3 | 通知监听 + 自动记账 | App 独有 |
| v0.4 | 语音输入 + Widget + 推送 | 体验增强 |

---

## 10. 调试与测试

### 本地开发环境连接

```
# 后端运行在电脑上
cd server && npm run dev  # localhost:3000

# Android 模拟器访问电脑
Base URL = http://10.0.2.2:3000/api

# 真机通过 WiFi 访问（同一局域网）
Base URL = http://192.168.x.x:3000/api
```

### 测试账号

用管理员登录后生成邀请码，注册测试用户：
- 管理员默认：admin / changeme123（或 .env 中配置的密码）

### cURL 测试示例

```bash
# 登录
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme123"}'

# 记账
curl -X POST http://localhost:3000/api/transactions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"client_id":"test-001","client_type":"app_android","source":"manual","type":"expense","amount":3200,"category_id":1,"description":"午饭","date":"2026-07-02"}]}'

# AI 解析
curl -X POST http://localhost:3000/api/ai/parse \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"input":"午饭32，打车15"}'
```
