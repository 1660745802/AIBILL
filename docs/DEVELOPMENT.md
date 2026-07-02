# 研发方案

## 一、技术栈

| 层级 | 技术选型 | 理由 |
|------|---------|------|
| 前端 | Vue3 + TypeScript + Vite + TailwindCSS | 轻量高效，生态成熟 |
| 移动端 | PWA（同一套 Web 代码） | 免 App 审核，加桌面图标即用 |
| 后端 | Node.js + Fastify + TypeScript | 快速开发，接 AI 方便 |
| 数据库 | SQLite (better-sqlite3) | 零运维，单文件备份 |
| AI | OpenAI / Claude / 兼容接口 | 自带 Key，按需切换 |
| 部署 | Docker / NAS / VPS | 简单灵活 |

---

## 二、分阶段研发计划

### M1 - 能记账（核心闭环）

#### 后端任务

1. **项目脚手架搭建**
   - Fastify + TypeScript 初始化
   - 目录结构：routes / services / ai / db / middleware / utils
   - 配置管理（.env + config.ts）

2. **数据库初始化**
   - schema.ts 建表（users / invite_codes / transactions / categories / accounts / settings / user_settings / schema_migrations）
   - migration 机制（schema_migrations 表记录版本）
   - seed 数据（全局设置默认值）

3. **认证模块**
   - POST /api/auth/register：邀请码注册
     - 事务内：校验邀请码 → 创建用户 → 生成默认分类（12支出+7收入） → 生成默认账户（4个） → 邀请码 used_count+1
   - POST /api/auth/login：bcrypt 验证 → 签发 JWT（30 天有效期）
   - GET /api/auth/me：获取当前用户信息
   - auth 中间件：解析 JWT → 注入 userId/role → 无效返回 401

4. **交易 CRUD**
   - POST /api/transactions：批量创建，client_id 幂等
   - GET /api/transactions：分页 + 筛选（日期/类型/分类/账户/关键词）
   - GET /api/transactions/:id：单条详情
   - PUT /api/transactions/:id：修改
   - DELETE /api/transactions/:id：软删除（设置 deleted_at）
   - 所有查询强制：`user_id = ? AND status = 'confirmed' AND deleted_at IS NULL`

5. **AI 记账解析模块**
   - LLM client 封装（ai/client.ts）：base_url + key + model 可配置
   - prompt 模板（ai/prompts.ts）：注入当天日期 + 用户分类/账户列表 + few-shot
   - 响应解析器（ai/parser.ts）：提取 JSON + 校验必填字段 + 金额转分
   - 分类匹配器（ai/category-matcher.ts）：精确 → 包含 → 同义词 → 其他
   - 错误处理：超时 10s 中断，返回 `{ code: 5001, fallback: "manual" }`

6. **分类/账户 CRUD**
   - GET/POST/PUT/DELETE /api/categories
   - GET/POST/PUT/DELETE /api/accounts

7. **管理员接口**
   - 邀请码管理（生成/列表/作废）
   - 用户管理（列表/启用/禁用）
   - 全局设置（AI 配置）

8. **用户设置**
   - GET /api/settings：合并全局 + 用户级
   - PUT /api/settings：修改用户级设置

#### 前端任务

1. **项目脚手架**：Vue3 + Vite + Pinia + Vue Router + TailwindCSS + API 层封装
2. **登录/注册页**：邀请码 + 用户名 + 密码
3. **首次使用引导**：欢迎 → 选账户 → 设余额 → 试记一笔（可跳过）
4. **首页 - 快速记账**：摘要卡片 + AI 输入框 + 确认卡片交互 + 今日流水
5. **手动记账表单**：类型/金额/分类/账户/日期/备注
6. **交易流水列表**：按日分组、搜索筛选、编辑删除
7. **PWA 配置**：manifest.json + Service Worker

---

### M2 - 能看懂（统计）

**后端**：
- GET /api/stats/summary：月度收支摘要（含环比）
- GET /api/stats/by-category：分类排行
- GET /api/stats/trend：日/月趋势

**前端**：
- 统计页（趋势折线图 + 分类饼图 + Top 排行）
- 首页摘要卡片完善

---

### M3 - 能对话（P1 AI 问答）

**后端**：
- AI 问答服务（注入当月+上月聚合统计，token < 2000）
- 对话会话管理（ai_conversations 表）
- POST /api/ai/chat、GET /api/ai/sessions、DELETE /api/ai/sessions/:id

**前端**：
- AI 对话页（消息气泡 + 新建/切换/删除对话）

---

### M4 - 能管理（P1 增强）

**后端**：
- 预算 CRUD + 使用率计算
- CSV 导入（微信/支付宝格式 + AI 分类 + 去重）
- 多账户余额计算
- 数据导出（JSON/CSV）
- 回收站（恢复/永久删除/30天自动清理）

**前端**：
- 预算设置页 + 超支提醒
- 导入页面（上传 → 预览 → 确认）
- 账户管理 + 余额展示
- 设置页（导出/回收站入口）

---

### M5 - 能部署

- Dockerfile（多阶段构建）+ docker-compose.yml
- .env.example 模板
- 首次启动自动创建 admin
- 移动端响应式验证
- README.md 部署文档


---

### P2-P3 工作台扩展

通过 migration 逐步实现：

| 阶段 | 模块 | 关键新增表 |
|------|------|-----------|
| P2a | Dashboard 仪表盘 | 无新表，聚合现有数据 |
| P2b | 订阅管理 | subscriptions |
| P2c | 负债中心 | debts + debt_payments |
| P2d | 备份多通道 | 配置项扩展 |
| P2e | Financial Analysis | AI 生成，存 ai_conversations |
| P3a | 投资理财 | investments + investment_transactions |
| P3b | AI 全局记忆 | ai_memories |
| P3c | 财务复盘 | 定时任务 + ai_conversations |
| P3d | 辅助工具 | 纯前端计算 / 第三方 API |

---

## 三、关键技术决策

| 决策 | 方案 | 原因 |
|------|------|------|
| 金额存储 | 整数（分） | 避免浮点精度，¥32.50 存为 3250 |
| 数据隔离 | 所有查询强制 `user_id = ?` | 隐私安全，管理员不可见他人数据 |
| 统计条件 | `status='confirmed' AND deleted_at IS NULL` | pending 不计入，软删除不计入 |
| AI Key | 服务端持有，前端不可见 | 安全 |
| 幂等 | client_id UNIQUE(user_id, client_id) | 防重复提交/重试 |
| 分类初始化 | 注册事务中自动生成 | 免额外调用 |
| JWT 有效期 | 30 天 | 自部署场景，减少登录摩擦 |
| 预算哨兵值 | category_id=0 总预算，month=0 全年 | SQLite UNIQUE 对 NULL 不生效 |
| 转账统计 | 不计入收支/预算 | 账户间流转不影响总收支 |

---

## 四、错误处理规范

| 场景 | 处理方式 |
|------|---------|
| LLM 返回非法 JSON | 正则提取 JSON 片段 → 失败则 fallback manual |
| LLM 超时 (>10s) | 中断请求，返回超时提示 + 手动模式按钮 |
| 分类匹配不上 | 归入"其他" |
| API Key 无效/余额不足 | 返回具体错误信息，引导设置页检查 |
| 网络不通 | 前端隐藏 AI 入口，显示手动表单 |
| 邀请码无效 | 返回 400 + 原因（已用完/过期/不存在） |
| 数据越权 | 查询不到返回 404（不暴露数据存在性） |

---

## 五、API 响应格式

```json
// 成功
{ "code": 0, "data": {...}, "message": "" }

// 错误
{ "code": 错误码, "data": null, "message": "错误描述" }
```

| 错误码范围 | 含义 |
|-----------|------|
| 1xxx | 认证/授权错误 |
| 2xxx | 参数校验错误 |
| 3xxx | 业务逻辑错误 |
| 4xxx | 外部依赖错误 |
| 5xxx | AI 相关错误 |

---

## 六、开发环境

```bash
# 后端
cd server && cp .env.example .env && npm install && npm run dev

# 前端
cd web && npm install && npm run dev
```

```env
PORT=3000
JWT_SECRET=随机长字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=初始密码
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=gpt-4o-mini
DB_PATH=./data/bill.db
```
