# 财务工作台扩展设计

> 本文档是 PRD.md 的延伸，规划 P2-P3 阶段的工作台模块。
> 前置依赖：P0（记账闭环）和 P1（统计/预算/导入/问答）已完成。

---

## 1. 产品全景

```
┌─────────────────────────────────────────────────────────────────┐
│                     AI 个人财务工作台                              │
├─────────────┬─────────────┬─────────────┬───────────┬───────────┤
│   记账      │   看板      │   规划      │   AI      │   设置    │
├─────────────┼─────────────┼─────────────┼───────────┼───────────┤
│• AI 快速记  │• Dashboard  │• 预算管理   │• AI 记账  │• 账户管理 │
│• 手动记账   │• 净资产     │• 负债中心   │• AI 问答  │• 分类管理 │
│• 账单导入   │• 趋势图     │• 投资理财   │• AI 信贷  │• 备份恢复 │
│• App 自动   │• 分类结构   │• 订阅管理   │• 财务复盘 │• 用户管理 │
│             │• 异常提醒   │• 目标储蓄   │• 全局记忆 │• AI 配置  │
└─────────────┴─────────────┴─────────────┴───────────┴───────────┘
  P0 ✅         P2            P1+P2         P1+P2+P3    P0 ✅
```

---

## 2. Dashboard 仪表盘（P2）

### 2.1 定位
首页从"简单摘要+今日流水"升级为可定制的财务仪表盘，一屏看清全貌。

### 2.2 模块组成

| 模块 | 内容 | 默认显示 |
|------|------|---------|
| 本月收支卡片 | 收入/支出/结余，环比变化 | ✅ |
| 净资产 | 所有账户余额总和 - 负债总额 | ✅ |
| 消费趋势 | 近 7 天/30 天支出折线图 | ✅ |
| 分类结构 | 本月支出分类饼图 + Top5 | ✅ |
| 预算进度 | 各分类预算使用条形图 | ✅（有预算时） |
| 异常提醒 | 单笔大额、连续超支、预算超标 | ✅ |
| 负债概览 | 待还总额、最近还款日 | 有负债时显示 |
| 投资概览 | 持仓市值、今日盈亏 | 有持仓时显示 |
| 最近流水 | 最新 5-10 笔交易 | ✅ |

### 2.3 可定制
- 拖拽排序模块
- 显示/隐藏模块
- 偏好存入 user_settings

### 2.4 异常提醒规则

| 规则 | 触发条件 | 提示内容 |
|------|---------|---------|
| 单笔大额 | 支出 > 用户月均日消费 × 5 | "今天有一笔 ¥X 的大额支出" |
| 连续超支 | 最近 3 天日均 > 月预算/30 × 1.5 | "最近几天花费偏高" |
| 预算超标 | 分类预算使用 > 80% | "餐饮预算已用 85%" |
| 还款提醒 | 还款日 ≤ 3 天 | "信用卡 X 将于后天到期还款" |

---

## 3. 负债中心（P2）

### 3.1 概述
管理所有负债（信用卡、花呗、消费贷、房贷等），追踪还款进度。

### 3.2 功能

#### 负债清单
| 字段 | 说明 |
|------|------|
| 名称 | 如"招行信用卡"、"花呗"、"房贷" |
| 类型 | credit_card / huabei / loan / mortgage / other |
| 总额 | 负债总金额（贷款）/ 账单金额（信用卡） |
| 已还 | 累计已还金额 |
| 剩余 | 未还金额 |
| 月还款额 | 每期应还 |
| 还款日 | 每月几号 |
| 利率 | 年利率（可选） |
| 状态 | active / paid_off |

#### 还款计划
- 自动生成每期还款时间表
- 标记实际还款（关联一笔 transaction）
- 逾期/即将到期高亮

#### AI 信贷识别
- 从导入的账单/AI 记账中自动识别分期、贷款类交易
- 提示"这看起来是一笔分期付款，是否添加到负债管理？"

### 3.3 数据模型

```sql
CREATE TABLE debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('credit_card', 'huabei', 'loan', 'mortgage', 'other')),
    total_amount INTEGER NOT NULL,       -- 总额（分）
    monthly_payment INTEGER,             -- 月还款额（分）
    payment_day INTEGER,                 -- 还款日（1-31）
    interest_rate REAL,                  -- 年利率
    start_date TEXT,                     -- 起始日期
    end_date TEXT,                       -- 预计结清日期
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paid_off')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE debt_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    debt_id INTEGER NOT NULL REFERENCES debts(id),
    amount INTEGER NOT NULL,             -- 还款金额（分）
    payment_date TEXT NOT NULL,          -- 还款日期
    transaction_id INTEGER REFERENCES transactions(id),  -- 关联交易记录
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 4. 投资理财（P3）

### 4.1 概述
追踪基金/股票持仓，AI 辅助分析。轻量级，不做交易。

### 4.2 功能

| 功能 | 说明 |
|------|------|
| 持仓管理 | 添加持有的基金/股票，记录份额和成本 |
| 市值追踪 | 接入公开行情数据，展示当前市值和盈亏 |
| 投资流水 | 买入/卖出/分红记录 |
| 自选列表 | 关注的基金/股票，可不持有 |
| AI 分析 | 基于持仓组合给出资产配置建议 |

### 4.3 数据模型

```sql
CREATE TABLE investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,                  -- 基金/股票名称
    code TEXT,                           -- 代码（如 001234）
    type TEXT CHECK(type IN ('fund', 'stock', 'bond', 'other')),
    shares REAL,                         -- 持有份额/股数
    cost_price REAL,                     -- 成本价
    current_price REAL,                  -- 最新价（定期更新）
    account TEXT,                        -- 持仓账户（如"天天基金"）
    status TEXT DEFAULT 'holding' CHECK(status IN ('holding', 'sold', 'watching')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE investment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    investment_id INTEGER REFERENCES investments(id),
    type TEXT NOT NULL CHECK(type IN ('buy', 'sell', 'dividend', 'bonus')),
    amount REAL NOT NULL,                -- 金额
    shares REAL,                         -- 份额变动
    price REAL,                          -- 成交价
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 5. 订阅管理（P2）

### 5.1 概述
追踪周期性订阅支出（视频会员、云服务、App 订阅等），避免忘记续费或不知不觉花太多。

### 5.2 功能

| 功能 | 说明 |
|------|------|
| 订阅清单 | 名称、金额、周期（月/季/年）、下次扣费日 |
| 支出汇总 | 月度/年度订阅总支出 |
| 到期提醒 | 到期前 N 天提醒（可配置） |
| 自动记账 | 到期时自动生成一笔支出记录（可选） |

### 5.3 数据模型

```sql
CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,                  -- 订阅名称
    amount INTEGER NOT NULL,             -- 金额（分）
    cycle TEXT NOT NULL CHECK(cycle IN ('monthly', 'quarterly', 'yearly')),
    category_id INTEGER REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    start_date TEXT NOT NULL,            -- 起始日期
    next_payment_date TEXT,              -- 下次扣费日
    reminder_days INTEGER DEFAULT 3,     -- 提前几天提醒
    auto_record INTEGER DEFAULT 0,       -- 到期自动记账（0=否，1=是）
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'cancelled')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 6. AI 增强能力（P2-P3）

### 6.1 全局记忆

| 功能 | 说明 |
|------|------|
| 偏好沉淀 | AI 对话中识别长期偏好（"我一般午饭花 20-30"），自动保存 |
| 记忆管理 | 用户可查看、编辑、启用/停用每条记忆 |
| 上下文增强 | AI 调用时自动注入启用的记忆项 |

数据模型：
```sql
CREATE TABLE ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,               -- 记忆内容
    source TEXT,                         -- 来源（哪次对话总结出的）
    is_active INTEGER DEFAULT 1,         -- 启用/停用
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 6.2 财务复盘报告（P3）

周期性（周/月）自动生成财务报告：
- 本期收支概况
- 与上期对比（哪里多花/少花了）
- 预算执行情况
- 负债进展
- AI 建议（下期需要注意什么）

支持手动触发或定时生成，结果存入 ai_conversations。

### 6.3 AI 信贷管家（P2）

- 从交易记录中自动识别分期/贷款类支出
- 提示用户确认后归入负债中心
- 识别维度：商家名（花呗/白条/分期乐）、描述关键词（分期/还款/月供）

### 6.4 Financial Analysis（P2）

三维度分析页面：

| 维度 | 分析内容 |
|------|---------|
| 过去 | 消费结构变化、异常波动、趋势 |
| 现在 | 当前净资产、负债率、现金流健康度 |
| 未来 | 按当前趋势预测、预算剩余空间、负债结清时间 |

由 AI 生成分析文本 + 图表数据，用户可追问。

---

## 7. 备份策略（P2）

### 7.1 多通道备份

| 方式 | 说明 | 优先级 |
|------|------|--------|
| SQLite 文件 cp | 最简单，服务端定时 cron | P0 已有 |
| JSON 导出 | 完整数据 JSON，可用于恢复 | P1 |
| WebDAV | 同步到坚果云/自建 DAV 服务 | P2 |
| S3/OSS | 对象存储备份 | P2 |
| MySQL 快照 | 写入 MySQL，带 checksum | P3（参考 LedgerFlow） |

### 7.2 备份策略

```
每日自动备份 → 保留最近 30 天
每周归档 → 保留最近 12 周
每月归档 → 保留最近 12 个月
```

### 7.3 恢复
- JSON/SQLite 直接恢复
- WebDAV/OSS 列出版本列表，选择恢复
- 恢复前展示数据概要（笔数、时间范围），用户确认

---

## 8. 辅助工具（P3）

| 工具 | 说明 |
|------|------|
| 汇率转换 | 多币种转换，出国旅行/海淘记账时用 |
| 工资计算器 | 五险一金、个税计算，核对到手工资 |
| AA 分账 | 多人活动费用拆分计算 |
| 目标储蓄 | 设置储蓄目标（旅行基金/购房首付），追踪进度 |

---

## 9. 整体里程碑

按用户收益排序（高频使用 > 偶尔使用 > 锦上添花）：

| 阶段 | 模块 | 验收标准 | 用户收益 |
|------|------|---------|---------|
| **P0** | 记账核心 | 注册→引导→AI/手动记账→确认→流水→月度摘要 | 能记账了 |
| **P1** | 增强 | 统计图表 + 预算 + CSV 导入 + AI 问答 + 多账户 + 导出 | 看得懂钱去哪了 |
| **P2a** | Dashboard | 可定制仪表盘、净资产、异常提醒 | 一屏看清全貌 |
| **P2b** | 订阅管理 | 订阅清单 + 到期提醒 + 自动记账 | 不再忘记续费 |
| **P2c** | 负债中心 | 负债清单 + 还款计划 + AI 信贷识别 | 还款不逾期 |
| **P2d** | 备份多通道 | WebDAV + OSS | 数据安全感 |
| **P2e** | Financial Analysis | 过去/现在/未来分析页 | 理解财务趋势 |
| **P3a** | 投资理财 | 持仓 + 市值 + AI 分析 | 投资有数 |
| **P3b** | AI 全局记忆 | 偏好沉淀 + 上下文增强 | AI 越来越懂我 |
| **P3c** | 财务复盘 | 周/月自动报告 | 被动获得洞察 |
| **P3d** | 辅助工具 | 汇率/工资/AA/储蓄目标 | 偶尔用到很方便 |
| **P3e** | App 自动记账 | 通知/短信/OCR → pending → 确认 | 完全无感记账 |

> P2 内部不强制顺序，哪个先做完哪个先上。P3 按兴趣推进。

---

## 10. 与现有设计的关系

| 文档 | 职责 |
|------|------|
| PRD.md | P0-P1 核心记账闭环、API 契约、技术架构 |
| DATABASE.md | P0-P1 数据表（users/transactions/categories/accounts/budgets 等） |
| **WORKBENCH.md（本文档）** | P2-P3 工作台扩展模块设计、新增数据表 |

> 新增的表（debts、investments、subscriptions、ai_memories 等）在实现对应阶段时通过 migration 加入，不影响 P0-P1 的 schema。
