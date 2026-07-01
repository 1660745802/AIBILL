# 数据库设计

## 概述
- 存储引擎：SQLite，单文件，零运维，备份只需复制文件
- 金额存储：**统一用整数（分）**，避免浮点精度问题。¥32.50 存为 3250
- 版本管理：通过 migrations 目录管理 schema 变更
- 时间格式：ISO 8601 字符串（SQLite 无原生日期类型）
- 查询规范：所有业务查询必须带 `deleted_at IS NULL AND status = 'confirmed'` 双重条件（除回收站和管理页面外）

---

## 表结构

### 1. users - 用户

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| username | TEXT NOT NULL UNIQUE | 用户名（登录用） |
| password_hash | TEXT NOT NULL | 密码哈希（bcrypt） |
| nickname | TEXT | 昵称（显示用） |
| role | TEXT DEFAULT 'user' | 角色: admin / user |
| is_active | INTEGER DEFAULT 1 | 是否启用（0=禁用） |
| created_at | TEXT NOT NULL | 注册时间 |

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2. invite_codes - 邀请码

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| code | TEXT NOT NULL UNIQUE | 邀请码（8位随机字符串） |
| max_uses | INTEGER DEFAULT 1 | 最大使用次数 |
| used_count | INTEGER DEFAULT 0 | 已使用次数 |
| created_by | INTEGER | 创建者 user_id |
| expires_at | TEXT | 过期时间（NULL=永不过期） |
| created_at | TEXT NOT NULL | 创建时间 |

```sql
CREATE TABLE invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> **邀请码校验逻辑**：
> ```sql
> SELECT * FROM invite_codes
> WHERE code = ?
>   AND used_count < max_uses
>   AND (expires_at IS NULL OR expires_at > datetime('now'));
> ```

### 3. transactions - 交易记录（核心表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| user_id | INTEGER NOT NULL | 所属用户 |
| type | TEXT NOT NULL | 类型: expense / income / transfer |
| amount | INTEGER NOT NULL | 金额（**分**），¥32.50 = 3250 |
| category_id | INTEGER | 关联分类（transfer 类型为 NULL） |
| account_id | INTEGER | 关联账户 |
| target_account_id | INTEGER | 转账目标账户（仅 transfer 类型） |
| description | TEXT | 描述/备注 |
| date | TEXT NOT NULL | 交易日期 YYYY-MM-DD |
| time | TEXT | 交易时间 HH:mm |
| tags | TEXT | 标签，JSON 数组 |
| source | TEXT DEFAULT 'manual' | 来源: manual / ai / import_csv / app_notification / ocr / subscription |
| source_detail | TEXT | 原始来源内容（通知文本/CSV行/OCR文本，用于追溯和去重） |
| client_id | TEXT | 客户端幂等键（UUID v4，防重复提交） |
| client_type | TEXT DEFAULT 'web' | 客户端类型: web / app_android / app_ios / import_script |
| client_created_at | TEXT | 客户端本地生成时间（离线场景） |
| status | TEXT DEFAULT 'confirmed' | 状态: confirmed / pending（pending 不计入统计） |
| ai_raw_input | TEXT | AI 记账时的原始输入（可追溯） |
| created_at | TEXT NOT NULL | 创建时间 ISO8601 |
| updated_at | TEXT NOT NULL | 更新时间 ISO8601（由应用层在每次 UPDATE 时写入） |
| deleted_at | TEXT | 软删除时间（NULL 表示有效） |

```sql
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    category_id INTEGER REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    target_account_id INTEGER REFERENCES accounts(id),
    description TEXT,
    date TEXT NOT NULL,
    time TEXT,
    tags TEXT DEFAULT '[]',
    source TEXT DEFAULT 'manual' CHECK(source IN ('manual', 'ai', 'import_csv', 'app_notification', 'ocr', 'subscription')),
    source_detail TEXT,
    client_id TEXT,
    client_type TEXT DEFAULT 'web' CHECK(client_type IN ('web', 'app_android', 'app_ios', 'import_script')),
    client_created_at TEXT,
    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'pending')),
    ai_raw_input TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE UNIQUE INDEX idx_transactions_client_id ON transactions(user_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_deleted ON transactions(deleted_at);
```

> **金额换算约定**：
> - 前端展示时：`amount / 100` 转为元
> - 前端提交时：`amount * 100` 转为分
> - AI 返回的浮点金额由服务端统一转换：`Math.round(aiAmount * 100)`

### 4. categories - 分类

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| user_id | INTEGER NOT NULL | 所属用户 |
| name | TEXT NOT NULL | 分类名称 |
| type | TEXT NOT NULL | expense / income |
| icon | TEXT | 图标（emoji） |
| parent_id | INTEGER | 父分类（支持二级分类） |
| sort_order | INTEGER DEFAULT 0 | 排序权重 |
| is_active | INTEGER DEFAULT 1 | 是否启用（0=停用，不删除） |

```sql
CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
    icon TEXT DEFAULT '📦',
    parent_id INTEGER REFERENCES categories(id),
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    UNIQUE(user_id, name, type)
);
```

**默认分类数据**：

> 以下数据不是全局 seed，而是**用户注册时自动为该用户生成**。
> 后端注册逻辑中以 `user_id = 新用户ID` 插入。

```sql
-- 注册时为新用户插入的默认支出分类（user_id 由代码填入）
INSERT INTO categories (user_id, name, type, icon, sort_order) VALUES
(?, '餐饮', 'expense', '🍜', 1),
(?, '交通', 'expense', '🚗', 2),
(?, '购物', 'expense', '🛒', 3),
(?, '住房', 'expense', '🏠', 4),
(?, '娱乐', 'expense', '🎮', 5),
(?, '医疗', 'expense', '🏥', 6),
(?, '教育', 'expense', '📚', 7),
(?, '通讯', 'expense', '📱', 8),
(?, '日用', 'expense', '🧴', 9),
(?, '服饰', 'expense', '👕', 10),
(?, '人情', 'expense', '🎁', 11),
(?, '其他', 'expense', '📦', 99);

-- 注册时为新用户插入的默认收入分类
INSERT INTO categories (user_id, name, type, icon, sort_order) VALUES
(?, '工资', 'income', '💰', 1),
(?, '奖金', 'income', '🎉', 2),
(?, '理财', 'income', '📈', 3),
(?, '兼职', 'income', '💼', 4),
(?, '红包', 'income', '🧧', 5),
(?, '退款', 'income', '↩️', 6),
(?, '其他', 'income', '📦', 99);
```

### 5. accounts - 账户

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| user_id | INTEGER NOT NULL | 所属用户 |
| name | TEXT NOT NULL | 账户名称（同一用户内唯一） |
| type | TEXT | 类型: cash/wechat/alipay/bank/credit/other |
| icon | TEXT | 图标 |
| initial_balance | INTEGER DEFAULT 0 | 初始余额（分），手动设置 |
| sort_order | INTEGER DEFAULT 0 | 排序 |
| is_active | INTEGER DEFAULT 1 | 是否启用 |

```sql
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT DEFAULT 'other' CHECK(type IN ('cash', 'wechat', 'alipay', 'bank', 'credit', 'other')),
    icon TEXT DEFAULT '💳',
    initial_balance INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    UNIQUE(user_id, name)
);

-- 注册时为新用户插入的默认账户（user_id 由代码填入）
INSERT INTO accounts (user_id, name, type, icon, sort_order) VALUES
(?, '微信', 'wechat', '💚', 1),
(?, '支付宝', 'alipay', '🔵', 2),
(?, '银行卡', 'bank', '💳', 3),
(?, '现金', 'cash', '💵', 4);
```

> **账户余额计算方式**：
> ```sql
> 当前余额 = initial_balance
>          + SUM(income where account_id = ?)
>          - SUM(expense where account_id = ?)
>          + SUM(transfer where target_account_id = ?)  -- 转入
>          - SUM(transfer where account_id = ?)         -- 转出
> ```
> 不单独存 balance 字段，避免数据不一致。

### 6. budgets - 预算

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| category_id | INTEGER NOT NULL DEFAULT 0 | 分类（**0 表示总预算**，不用 NULL） |
| amount | INTEGER NOT NULL | 预算金额（分） |
| period | TEXT DEFAULT 'monthly' | 周期: monthly / yearly |
| year | INTEGER NOT NULL | 年份 |
| month | INTEGER NOT NULL DEFAULT 0 | 月份（**0 表示全年**，不用 NULL） |

```sql
CREATE TABLE budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category_id INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL CHECK(amount > 0),
    period TEXT DEFAULT 'monthly' CHECK(period IN ('monthly', 'yearly')),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, category_id, year, month)
);
```

> **为什么不用 NULL**：SQLite 中 `UNIQUE` 约束对 NULL 值不生效（多个 NULL 被视为不同值），
> 改用 `0` 作为哨兵值，确保同一用户同一分类同一月份只能有一条预算。
> - `category_id = 0` → 总预算
> - `month = 0` → 年度预算（period = 'yearly' 时）

### 7. ai_conversations - AI 对话记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PRIMARY KEY | 自增主键 |
| session_id | TEXT NOT NULL | 对话会话 ID（UUID，区分不同对话） |
| role | TEXT NOT NULL | user / assistant / system |
| content | TEXT NOT NULL | 消息内容 |
| metadata | TEXT | 附加信息（JSON，如 token 用量、模型名） |
| created_at | TEXT NOT NULL | 创建时间 |

```sql
CREATE TABLE ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_conversations_user ON ai_conversations(user_id);
CREATE INDEX idx_ai_conversations_session ON ai_conversations(session_id);
CREATE INDEX idx_ai_conversations_created ON ai_conversations(created_at);
```

### 8. settings - 全局设置（admin 管理）

仅存放系统级配置，由 admin 管理。

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 默认全局设置
INSERT INTO settings (key, value) VALUES
('ai_base_url', 'https://api.openai.com/v1'),
('ai_api_key', ''),
('ai_model', 'gpt-4o-mini'),
('ai_temperature_parse', '0.1'),
('ai_temperature_chat', '0.7'),
('currency', 'CNY');
```

### 9. user_settings - 用户级设置

每个用户各自的偏好，与全局设置分离。

```sql
CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
);
```

> 用户级设置示例：`default_account_id`、`theme`、`ai_model`（用户可覆盖全局模型选择）
> 
> 查询优先级：user_settings > settings（用户有覆盖用用户的，没有则 fallback 到全局）

### 10. schema_migrations - 数据库版本

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始版本
INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_schema');
```

---

## ER 关系图

```
┌──────────────────┐
│      users       │
│──────────────────│
│ id            PK │◄──────────────────────────────────┐
│ username         │                                    │
│ password_hash    │                                    │
│ role             │    ┌──────────────────┐            │
│ is_active        │    │  invite_codes    │            │
└──────────────────┘    │──────────────────│            │
        │               │ id            PK │            │
        │               │ code             │            │
        │               │ max_uses         │            │
        │               │ used_count       │            │
        │               │ created_by    FK │────────────│
        │               │ expires_at       │            │
        │               └──────────────────┘            │
        │                                               │
        ▼                                               │
┌──────────────┐         ┌──────────────┐              │
│  categories  │         │   accounts   │              │
│──────────────│         │──────────────│              │
│ id        PK │◄──┐     │ id        PK │◄──────┐     │
│ user_id   FK │───┼──►  │ user_id   FK │───────┼──►  │
│ name         │   │     │ name         │       │     │
│ type         │   │     │ type         │       │     │
│ icon         │   │     │ initial_     │       │     │
│ parent_id FK │───┘     │   balance    │       │     │
│ is_active    │         │ is_active    │       │     │
└──────────────┘         └──────────────┘       │     │
        ▲                                        │     │
        │         ┌──────────────────────┐       │     │
        │         │    transactions      │       │     │
        │         │──────────────────────│       │     │
        │         │ user_id          FK  │───────┼─────┘
        └─────────│ category_id      FK  │       │
                  │ account_id       FK  │───────┤
                  │ target_account_  FK  │───────┘
                  │   id                 │
                  │ type                 │
                  │ amount (分)          │
                  │ date                 │
                  │ description          │
                  │ source               │
                  │ deleted_at           │
                  └──────────────────────┘

┌──────────────────┐    ┌──────────────┐    ┌─────────────────┐
│ ai_conversations │    │   budgets    │    │ schema_         │
│──────────────────│    │──────────────│    │   migrations    │
│ id            PK │    │ id        PK │    │─────────────────│
│ user_id       FK │    │ user_id   FK │    │ version      PK │
│ session_id       │    │ category_id  │    │ name            │
│ role             │    │ amount (分)  │    │ applied_at      │
│ content          │    │ year         │    └─────────────────┘
│ metadata         │    │ month        │
│ created_at       │    │ UNIQUE(user, │
└──────────────────┘    │  cat,yr,mon) │
                        └──────────────┘
```

---

## 查询场景

> 所有查询都带 `user_id = ?` 和 `status = 'confirmed'` 条件，确保数据隔离且只统计已确认交易。

### 月度统计（金额以分存储，前端 / 100 展示）
```sql
SELECT type, SUM(amount) as total_cents
FROM transactions
WHERE user_id = ?
  AND status = 'confirmed'
  AND type IN ('expense', 'income')
  AND date BETWEEN '2026-07-01' AND '2026-07-31'
  AND deleted_at IS NULL
GROUP BY type;
```

### 分类排行
```sql
SELECT c.name, c.icon, SUM(t.amount) as total_cents, COUNT(*) as count
FROM transactions t
JOIN categories c ON t.category_id = c.id
WHERE t.user_id = ?
  AND t.status = 'confirmed'
  AND t.type = 'expense'
  AND t.date BETWEEN '2026-07-01' AND '2026-07-31'
  AND t.deleted_at IS NULL
GROUP BY t.category_id
ORDER BY total_cents DESC;
```

### 日趋势
```sql
SELECT date, SUM(amount) as daily_cents
FROM transactions
WHERE user_id = ?
  AND status = 'confirmed'
  AND type = 'expense'
  AND date BETWEEN '2026-07-01' AND '2026-07-31'
  AND deleted_at IS NULL
GROUP BY date
ORDER BY date;
```

### 账户当前余额
```sql
SELECT
  a.id,
  a.name,
  a.initial_balance
    + COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=a.user_id AND type='income' AND account_id=a.id AND status='confirmed' AND deleted_at IS NULL), 0)
    - COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=a.user_id AND type='expense' AND account_id=a.id AND status='confirmed' AND deleted_at IS NULL), 0)
    + COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=a.user_id AND type='transfer' AND target_account_id=a.id AND status='confirmed' AND deleted_at IS NULL), 0)
    - COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=a.user_id AND type='transfer' AND account_id=a.id AND status='confirmed' AND deleted_at IS NULL), 0)
  AS current_balance_cents
FROM accounts a
WHERE a.user_id = ? AND a.is_active = 1;
```

### 预算使用情况
```sql
SELECT
  b.id,
  CASE WHEN b.category_id = 0 THEN '总预算' ELSE c.name END as category_name,
  b.amount as budget_cents,
  CASE
    WHEN b.category_id = 0 THEN (
      SELECT COALESCE(SUM(amount), 0)
      FROM transactions
      WHERE user_id = b.user_id AND type = 'expense'
        AND status = 'confirmed'
        AND date BETWEEN '2026-07-01' AND '2026-07-31'
        AND deleted_at IS NULL
    )
    ELSE (
      SELECT COALESCE(SUM(amount), 0)
      FROM transactions
      WHERE user_id = b.user_id AND type = 'expense'
        AND category_id = b.category_id
        AND status = 'confirmed'
        AND date BETWEEN '2026-07-01' AND '2026-07-31'
        AND deleted_at IS NULL
    )
  END as spent_cents
FROM budgets b
LEFT JOIN categories c ON b.category_id = c.id AND b.category_id != 0
WHERE b.user_id = ? AND b.year = 2026 AND (b.month = 7 OR b.month = 0)
ORDER BY b.category_id;
```
