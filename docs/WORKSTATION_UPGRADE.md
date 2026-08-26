# 财务工作台升级规划

## 核心原则

1. **现有记账功能零改动** — App 端核心场景仍为记账，所有新功能纯增量
2. **渐进式升级** — 分 Phase 交付，每个 Phase 独立可用
3. **数据库向后兼容** — 仅 ALTER ADD COLUMN + 新表，不改旧表结构

## 当前定位 → 目标定位

| 维度 | 现在 | 目标 |
|------|------|------|
| 核心能力 | 记录流水 + 基础统计 | 全面管理个人财务健康 |
| 用户视角 | "我花了多少" | "我的财务状况如何，接下来该怎么做" |
| AI 角色 | 解析输入 + 回答问题 | 财务顾问（分析、预警、规划建议） |

---

## Phase 1: 资产全景 ✅ (已实现)

### 数据库变更 (Migration #8)

```sql
-- accounts 表扩展
ALTER TABLE accounts ADD COLUMN asset_type TEXT DEFAULT 'liquid';
  -- liquid(活期) / savings(定期) / investment(理财投资)
  -- credit(信用卡) / loan(贷款) / property(不动产) / other
ALTER TABLE accounts ADD COLUMN currency TEXT DEFAULT 'CNY';
ALTER TABLE accounts ADD COLUMN credit_limit INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN billing_day INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN due_day INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN note TEXT;

-- 新表: asset_snapshots (月度快照)
-- 新表: recurring_patterns (周期性收支模式)
-- 新表: financial_goals (财务目标)
-- 新表: goal_progress (目标进度快照)
```

### 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/assets/overview | 净资产概览（总资产、总负债、分类汇总、账户列表） |
| GET | /api/assets/trend?months=6 | 净资产历史趋势 |
| POST | /api/assets/snapshot | 手动触发快照 |
| PUT | /api/assets/accounts/:id | 更新账户资产属性 |
| GET | /api/goals | 目标列表 |
| POST | /api/goals | 创建目标 |
| PUT | /api/goals/:id | 更新目标 |
| DELETE | /api/goals/:id | 删除目标 |
| POST | /api/goals/:id/progress | 记录进度 |
| GET | /api/goals/:id/progress | 进度历史 |

### 新增前端页面

- `/assets` — 资产全景页（净资产卡片 + 分布饼图 + 趋势折线图 + 账户列表）
- `/goals` — 财务目标页（目标列表 + 进度条 + 新建/编辑/删除）

---

## Phase 2: 现金流预测 (待开发)

### 功能

- AI 分析历史数据，识别周期性收支模式（工资、房租、话费…）
- 基于固定收支 + 历史均值 + 订阅，预测未来 3-6 个月现金流
- 预测某月出现现金流缺口时提前预警
- "What-if" 模拟（如果多还贷款 2000，现金流如何？）

### 数据库

利用 Phase 1 已建的 `recurring_patterns` 表。

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/forecast/cashflow?months=6 | 现金流预测 |
| GET | /api/forecast/patterns | 已识别的周期模式 |
| POST | /api/forecast/patterns | 手动添加周期模式 |
| POST | /api/forecast/simulate | What-if 模拟 |

---

## Phase 3: 财务健康度 (待开发)

### 功能

- 财务健康评分（综合储蓄率、负债率、应急储备、投资多样性）
- 月度/年度自动财务报告（AI 生成）
- 智能建议（基于数据的个性化建议）
- 异常检测（大额支出、消费模式变化）

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health/score | 财务健康评分 |
| GET | /api/health/report?period=monthly | 周期报告 |
| GET | /api/health/suggestions | AI 建议 |
| GET | /api/health/alerts | 异常提醒 |

---

## Phase 4: 投资追踪 (可选)

### 功能

- 持仓管理（基金/股票/理财产品）
- 收益计算（持有收益、已实现收益、年化收益率）
- 资产配置（按风险等级分类，查看比例）
- 净值更新（手动或定期快照）

### 新表

```sql
CREATE TABLE holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT,
    type TEXT CHECK(type IN ('fund', 'stock', 'bond', 'deposit', 'other')),
    shares REAL,
    cost_basis INTEGER,        -- 成本（分）
    current_value INTEGER,     -- 当前市值（分）
    account_id INTEGER,
    last_updated TEXT,
    status TEXT DEFAULT 'active'
);

CREATE TABLE holding_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id INTEGER NOT NULL,
    type TEXT CHECK(type IN ('buy', 'sell', 'dividend', 'fee')),
    amount INTEGER NOT NULL,
    shares REAL,
    price_per_share REAL,
    date TEXT NOT NULL
);
```

---

## 执行优先级

```
Phase 1 (资产全景 + 目标) ✅ 已完成
    ↓
Phase 2 (现金流预测)       ← 最有价值的差异化功能
    ↓
Phase 3 (财务健康度)       ← 用户粘性，持续回看
    ↓
Phase 4 (投资追踪)         ← 可选，复杂度高
```

## 对现有功能的影响

- ✅ 记账功能：**零改动**
- ✅ 统计功能：**零改动**
- ✅ 预算功能：**零改动**
- ✅ 订阅功能：**零改动**
- ✅ AI 功能：**零改动**
- ⚡ accounts 表：新增字段（默认值保证兼容）
- ⚡ 导航栏：新增"资产"和"目标"入口
