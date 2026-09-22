# 架构设计

> 本文整合原 PRD.md 与 DEVELOPMENT.md，作为项目的**架构基线文档**。
> 数据模型见 [DATA.md](DATA.md)；API 见 [API.md](API.md)。

---

## 1. 产品定位

### 1.1 一句话
自部署的 AI 个人财务工作台：说一句话就能记账，支持小范围多人使用。

### 1.2 设计原则
- **记账零摩擦**：说一句话就记完，不用填表单
- **记得准**：AI 解析 + 用户确认，常见输入一次通过率 > 80%
- **数据在自己手里**：自部署，业务数据不上传第三方
- **多端统一接口**：Web、App 共用同一套 API，来源可追溯
- **用户间完全独立**：各自记账互不可见，管理员不能看他人数据
- **AI 失败不阻塞**：任何 AI 环节出错，用户都能无感切到手动完成

### 1.3 体验指标

| 指标 | 目标 |
|------|------|
| 打开→入账步数 | ≤ 3（输入→确认→完成） |
| AI 成功耗时 | ≤ 5 秒 |
| AI 失败损失 | 0（无感切手动，输入保留） |
| 批量记账 | 3 条 ≈ 1 条的时间 |

### 1.4 统计口径

| 交易类型 | 计入支出 | 计入收入 | 计入预算 |
|---------|---------|---------|---------|
| 普通支出 | ✅ | — | ✅ |
| 普通收入 | — | ✅ | — |
| 转账 | ❌ | ❌ | ❌ |
| 退款/报销（收入分类） | — | ✅ | ❌ |

### 1.5 去重规则

| 场景 | 策略 |
|------|------|
| 幂等重试 | 同一 `client_id` → 直接返回已有记录 |
| 导入重复 | 同 user + source + amount + date + description → 提示确认 |
| App 通知重复 | 同一 `source_detail` 哈希 → 自动跳过 |

### 1.6 交易状态

| 状态 | 用途 |
|------|------|
| `confirmed` | 已确认，入账（默认值） |
| `pending` | 待确认（App 自动识别候选），**不计入统计** |

---

## 2. 技术架构

### 2.1 整体图

```
┌─────────────────────────────────────────────────┐
│                   客户端                          │
├──────────────────────┬──────────────────────────┤
│   Web (Vue3 + Vite)  │  移动端 (PWA / App)      │
└──────────┬───────────┴──────────┬───────────────┘
           │         HTTPS        │
           ▼                      ▼
┌─────────────────────────────────────────────────┐
│            后端 API (Node.js + Fastify)           │
│                                                  │
│  JWT 鉴权 → 路由层 → 业务逻辑 → 数据访问层     │
│                                  ↓               │
│                          SQLite + AI Engine      │
└──────────────────────┬──────────────────────────┘
                       ▼
                 OpenAI / 兼容 API
```

### 2.2 技术栈

| 层级 | 技术 | 理由 |
|------|------|------|
| 前端 | Vue3 + TypeScript + Vite + TailwindCSS | 轻量高效，生态成熟 |
| 移动端 | PWA（同一套 Web 代码）+ Android App | 免 App 审核 / 复用 API |
| 后端 | Node.js + Fastify + TypeScript | 快速开发，接 AI 方便 |
| 数据库 | SQLite (better-sqlite3) | 自用无需 MySQL，零运维，单文件备份 |
| AI | OpenAI / Claude / 任意兼容接口 | 自带 Key，按需切换 |
| 部署 | Docker / NAS / VPS | 简单 |

### 2.3 LLM 调用架构

**为什么放服务端：**
1. API Key 安全——不暴露在前端代码/浏览器
2. 服务端拼接 prompt + 附带用户历史摘要
3. 换模型、调参数、加 fallback 都集中在一处

**调用时序：**

```
前端 ── POST /api/ai/parse ──► 后端
                                ├─ 拼 prompt（few-shot + 分类/账户列表 + user_input 包裹）
                                ├─ 调用 LLM API
                                ├─ 校验 JSON + 金额转分 + 分类名匹配
                                ◄── 结构化数据 ── 前端展示确认卡片
前端 ── POST /api/transactions ──► 入库
```

**错误处理：**

| 异常 | 处理 |
|------|------|
| LLM 返回非法 JSON | 尝试提取 JSON 片段 → 失败提示切手动 |
| LLM 超时（>10s） | 返回超时提示 + 手动模式按钮 |
| 分类名匹配不上 | 模糊匹配 → 归入"其他" |
| API Key 无效/余额不足 | 返回具体错误，引导设置页检查 |
| 网络不通 | 前端离线直接展示手动表单 |

---

## 3. 认证与多端契约

### 3.1 角色

| 角色 | 权限 |
|------|------|
| `admin` | 邀请码 + 用户 + 全局 AI 配置 + 自己的记账数据 |
| `user` | 注册/登录 + 自己的记账数据 |

**隐私原则**：记账数据极度私密，**管理员不可查看其他用户数据**。详见 [DATA.md §1 概览](DATA.md)。

### 3.2 注册流程
```
用户访问注册页 → 邀请码 + 用户名 + 密码
后端校验邀请码（存在、未过期、未用完）
同一事务内：创建用户 + 生成默认分类 + 生成默认账户
邀请码 used_count + 1 → 返回 JWT
```
默认分类/账户在事务中静默生成，前端无需额外调用。首次引导仅做 UI 层引导。

### 3.3 登录流程
```
用户名 + 密码 → bcrypt 比对 → 签发 JWT（payload 含 jti，30 天有效）
前端存 localStorage → Authorization: Bearer <jwt>
```
详见 [API.md §1 认证](API.md)。

### 3.4 多端接入规范（API 契约）

```json
POST /api/transactions
{
  "items": [{
    "client_id": "uuid-v4",          // 幂等键
    "client_type": "web",            // web | app_android | app_ios | import_script
    "client_created_at": "ISO8601",  // 离线场景用
    "source": "ai",                  // manual | ai | import_csv | app_notification | ocr | subscription
    "source_detail": "...",          // 原始来源内容
    "type": "expense",
    "amount": 3200,
    "category_id": 1,
    "account_id": 1,
    "target_account_id": null,       // 仅 transfer 时必填
    "description": "午饭",
    "date": "2026-07-01"
  }]
}
```

**统一规则**：始终用 `items` 数组；单条记账传 `items: [单条对象]`，批量传多条。

---

## 6. 功能清单

| 阶段 | 模块 | 状态 |
|------|------|------|
| **P0** | 鉴权（邀请码 + JWT） | ✅ |
| **P0** | AI 快速记账 + 确认卡片 | ✅ |
| **P0** | 手动记账（AI fallback） | ✅ |
| **P0** | 流水列表 / 软删除 | ✅ |
| **P0** | 首次引导 | ✅ |
| **P0** | 多端统一 API | ✅ |
| **P1** | 统计概览（图表/分类饼图/趋势） | ✅ |
| **P1** | 预算管理（总/分类，超支提醒） | ✅ |
| **P1** | CSV 导入（微信/支付宝） | ✅ |
| **P1** | AI 问答（基于个人数据） | ✅ |
| **P1** | 多账户 + 余额计算 | ✅ |
| **P1** | 数据导出（JSON/CSV） | ✅ |
| **P1** | 回收站（30 天保留） | ✅ |
| **P2a** | Dashboard 仪表盘（净资产/趋势/异常提醒） | ✅ |
| **P2b** | 订阅管理（周期/到期提醒/自动记账） | ✅ |
| **P2e** | Financial Analysis（过去/现在/未来） | ✅ |
| **P3b** | AI 全局记忆 | ✅ |
| **P2c** | 负债中心（计划） | 📋 |
| **P2d** | 现金流预测（计划） | 📋 |
| **P3a** | 投资理财（计划） | 📋 |
| **P3e** | App 通知/OCR 自动记账（计划） | 📋 |

P2-P3 详细数据模型见 [DATA.md §3-4](DATA.md)。

---

## 7. 部署与环境

### 7.1 环境变量

```env
PORT=3000
JWT_SECRET=随机长字符串（≥32 字符）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=初始密码
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=gpt-4o-mini
DB_PATH=./data/bill.db
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

### 7.2 Docker 部署（推荐）
```bash
git clone <repo-url> && cd bill
cat > .env << EOF
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=your-strong-password
AI_API_KEY=sk-your-openai-key
EOF
docker-compose up -d
```
数据存储在宿主机 `~/.bill/`。

### 7.3 本地开发
```bash
# 后端（端口 3000）
cd server && cp .env.example .env && npm install && npm run dev

# 前端（端口 5173，自动代理）
cd web && npm install && npm run dev
```

### 7.4 数据库迁移
启动时自动检测并执行未应用的 migration。`schema_migrations` 表记录已应用版本。**禁止修改已应用的 migration，只能新增**。

### 7.5 备份
- SQLite 文件 cp 即备份
- 设置 → 数据管理 → 导出 JSON 备份

---

## 8. 错误处理规范

| 场景 | 处理 |
|------|------|
| LLM 非法 JSON | 正则提取 → 失败 fallback manual |
| LLM 超时 (>10s) | 中断请求 + 手动模式按钮 |
| 分类匹配不上 | 归入"其他" |
| API Key 无效 | 引导设置页检查 |
| 邀请码无效 | 400 + 原因（已用完/过期/不存在） |
| 越权访问 | 404（不暴露数据存在性） |

所有错误统一通过 [API.md §6 错误码](API.md) 返回。

---

## 9. 路线图

| 里程碑 | 验收标准 |
|--------|---------|
| M1 能记账 | 注册 → AI/手动 → 流水可查 |
| M2 能看懂 | 月度摘要 + 分类饼图 + 趋势图 |
| M3 能对话 | AI 问答基于个人数据回答 |
| M4 能管理 | 预算 + CSV 导入 + 多账户 |
| M5 能部署 | Docker 一键部署，PWA 桌面化 |

**当前进度**：P0-P3b 已完成（详见 §6），P2c-P3e 为未来规划。

---

## 10. 文档导航

| 文档 | 职责 |
|------|------|
| [README.md](../README.md) | 项目简介、快速启动 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构、技术栈、功能清单、部署（本文） |
| [DATA.md](DATA.md) | 数据模型、表结构、查询模式 |
| [API.md](API.md) | 全部 80+ 端点契约 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发规范、Git 流程、安全规范 |
| [TESTING.md](TESTING.md) | 测试策略与用例清单 |