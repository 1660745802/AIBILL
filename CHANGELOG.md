# Changelog

所有版本变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 界面重做：账本纸（Ledger Paper）
- **设计语言重建**：从「暖奶油底 + 靛蓝圆角卡片」改为「账本纸」——结构由发丝线与表格行承载，颜色只表达含义（收/支/警/信息），主操作为石墨实底而非品牌色。完整规格见 `docs/UI-DESIGN.md`
- **墨色拆成两个角色**：`--color-ink-1` 只用于文字（近黑），大面积填充改用 `--color-action`（石墨 `#39434b`）——纯黑填充块在大片浅纸上压版面
- **新增 15 个原子组件**（`web/src/components/ui/`）：`Money` `PageHeader` `LedgerLabel` `StatTile` `Meter` `SegmentedControl` `PeriodNav` `BaseModal` `Notice` `EmptyState` `Skeleton` `SheetRow` `AppIcon` `ToastHost` `ConfirmHost`；原 `EmptyState` / `Skeleton` / `TodayList` 删除
- **深色模式**：`prefers-color-scheme: dark` 全站自动生效；新增 `--color-action-fg` / `--color-on-tone` 前景色 token（否则深色下 action 变亮、硬编码 `#fff` 会白底白字）
- **图表配色**：`utils/chart.ts` 统一处理 canvas 不认 CSS 变量 / `var()` / `color-mix()` 的问题，并在配色方案切换时自动重绘
- **原生弹窗全部替换**：`confirm()` → `useConfirm()` + `ConfirmHost`（文案说明后果，危险操作用描边红）
- **响应式**：手机吸顶报头 + 底部 5 槽 + 凸起 FAB；320px 起无横向溢出（修掉 `PageHeader` 吸顶负边距 `-1.5rem` 超出容器 `1rem` 内边距导致的 8px 溢出）

### 信息架构：按真实使用频率重构
三个月真实数据（550 笔交易、87/90 活跃天）：`budgets` / `financial_goals` / `subscriptions` / `ai_memories` / `asset_snapshots` 五张表**均为 0 行**；调用日志里 91% 的记账来自通知快捷入口。据此：
- **落地页改为记账**：`/` 从 Dashboard 改为记账页（原 `/quick` 重定向到 `/`）；原 Dashboard 移到 `/overview`，定位为「本月结算单」
- **导航分层**：一级只留「记一笔 / 账本 / 本月 / AI 助手」，其余收进「偶尔」分组；移动端底栏改为「账本 / 本月 / FAB 记一笔 / 助手 / 我的」
- **下线 5 个零使用功能**（Web 端）：预算、财务目标、订阅管理、AI 记忆、资产快照；删除 `Budget.vue` `Goals.vue` `Subscriptions.vue` `api/goals.ts`，并从 Dashboard / Home / Me / Settings / Assets 中移除相关区块
- **后端接口与数据表全部保留**（`/api/budgets/*` `/api/goals/*` `/api/subscriptions/*` `/api/memories/*` `/api/assets/snapshot|/trend`），`GET /api/stats/dashboard` 响应结构不变，避免影响已发布的移动 App；旧 Web 路由 302 到 `/me` 而非 404

### Fixed
- **SPA 深链 500**：`@fastify/static` 用 `decorateReply:false` 注册后 `reply.sendFile` 不存在，导致 `/quick` `/ledger` 等任何非根路径硬刷新返回 **HTTP 500**（`GET /favicon.ico` 同）。改为自行读文件流发送；`/favicon.ico` 改为 302 到图标
- **改密后被静默踢下线**：`auth` store 定义了 `setAuth` 但未 return，`Settings.vue` 调用 `auth.setAuth()` 必抛 `TypeError`，新 token 写不进 localStorage。现已导出
- **支出显示为正数**：`Money` 组件的 `sign="auto"` 按数值正负取号，支出（红色）会渲染成 `+¥456.00`。改为按语义色取号：支出恒 `-`、收入恒 `+`
- **标签渲染成原始 JSON**：账本直接把 `tags` 字段（JSON 字符串）插值，显示为 `#["吃的","多喝水"]`。改为解析成数组，最多展示 2 个 + `+N`
- **悬空分隔符**：日期无时分秒时元信息行渲染成「餐饮 · 」

### Refactor（行为不变）
- **日期口径收拢**：新增 `lib/date.ts`（`monthRange` / `prevMonthRange` / `today` / `dateOffset` / `toDateStr`），替换 stats / budget / transaction 中重复的 6 段“算月首月末日”代码；统一走本地时区
- **预算阈值收拢**：新增 `lib/budget.ts`（`WARN_PERCENT=80` / `OVER_PERCENT=100` / `budgetStatus` / `budgetProgress`），替换 3 处重复的百分比与状态判断
- **消除重复聚合**：`stats/dashboard` 不再为资产分布重跑一遍与净资产完全相同的聚合 SQL，改为对已查出的账户行内存分组（验证与 `assets/overview` 的独立实现结果一致）
- **消除预算 N+1**：`GET /api/budgets` 原来每条预算各查一次支出，改为一次 `GROUP BY` 预取
- **金额格式化收拢**：新增 `web/src/utils/money.ts`（`formatAmount` / `formatYuan` / `formatCompact` / `centsToYuan` / `yuanToCents`），替换 11 个 `.vue` 中各自复制的一份 `(cents/100).toFixed(2)`，并把 Dashboard / Assets / Goals 的重复实现改为复用
- **删除死代码**：`lib/response.ts` 中从未被调用的 `success()` / `fail()`、`lib/error-codes.ts`（常量表零引用，权威表在 docs/API.md §0.3）、`auth.service.ts` 的 `disableUser()`（逻辑已在 admin 路由内联）、`AccountManager.vue` 的 `formatBalance()`、3 处未使用变量（TS6133）、5 个已空目录的 `.gitkeep`
- **统一净资产口径**（新增 `lib/assets.ts` `summarizeNetWorth`，两接口共用）：`/api/stats/dashboard` 与 `/api/assets/overview` 曾对“总负债”用两套口径——总览页说 ¥800、资产页说 ¥1300，且 dashboard 的口径违反会计恒等式。现在统一为“负余额计负债、正余额计资产”，并顺带修掉“按 asset_type 分组后取绝对值”导致信用卡溢缴款抵消其他卡欠款的问题；dashboard 补上 `total_assets`
- 新增 `tests/lib/helpers.test.ts`（12 例）覆盖 date / budget / assets 三个公共模块，新增 `tests/routes/networth.test.ts`（5 例）做两接口交叉一致性断言

### Fixed
- **删除用户必 500**：`DELETE /api/admin/users/:id` 的删除顺序违反外键约束（`subscriptions` / `financial_goals` 未先删、`categories`/`accounts` 早于子表删），只要用户用过订阅或财务目标就会 `SQLITE_CONSTRAINT_FOREIGNKEY`。改为声明式有序表（`USER_SCOPED_TABLES`，依赖倒序）+ `created_by` 置空 + 可读错误兜底
- **CSV 导入 >50 条整批失败**：批量上限 50→200，前端按 100 条分片提交，单片失败不再中断其他片（此前一条非法数据会导致整批回滚，真实账单场景不可用）
- **导入记录丢失分类**：解析时按商户关键词预填分类（新增 `lib/import-matcher.ts`），此前 `category_id` 恒为 NULL，导致分类统计（`JOIN categories`）、分类预算回溯、AI 分类分析均看不到导入数据
- **导入无去重**：新增同 `user + type + amount + date + description` 重复检测（对比已有记录 + 批次内部，回收站不计），预览页默认跳过重复项并可勾选包含
- **改密后当前设备被静默踢下线**：`PUT /api/auth/password` 现在为当前设备换发新 token（`data.token`），旧 token 仍按 `token_version` 失效，其他设备行为不变
- **AI 聊天丢失最近上下文**：历史消息改为 `ORDER BY id DESC LIMIT 20` 后反转（此前取的是最早 20 条，超过 10 轮后模型看不到最近对话）；`GET /api/ai/sessions` 的 `first_message` 改用 `MIN(id)` 关联子查询（`MIN(content)` 是字典序最小而非时间最早）
- `POST /api/import/csv` 参数校验失败的错误码由 `1` 统一为 `2000`（原先不在错误码表内）

### Added
- **CHANGELOG.md**（本文件）
- 账单导入支持分类预填 + 重复标记 + 逐行改分类 / 批量归类
- 测试：新增 `tests/routes/admin.test.ts`（9）、`tests/routes/import.test.ts`（16）、`tests/routes/ai-chat.test.ts`（5），`auth.test.ts` 补充 2 例；总计 96 → 128

### Security
- **CORS 白名单**：通过 `CORS_ORIGINS` 环境变量配置，默认 `localhost:5173,localhost:3000`
- **JWT 撤销机制**：新增 `users.token_version` 字段（migration 009）；改密 / 重置密码 / 禁用用户自动 bump，旧 token 立即失效（O(1)，无黑名单查询开销）
- **限流**：登录 / 注册 `5/分钟`，AI 路由 `20/分钟`
- **bcrypt cost 10 → 12**
- **AI prompt 注入防护**：用户输入 `<user_input>` 标签包裹；system prompt 显式声明忽略内部指令；`ai_memories` 注入只取 `source='manual'`
- **新增错误码 `1006`**：令牌已失效（密码已修改或账号已重置）

### Performance
- 修复 `assets.ts` 净资产 N+1：原每账户 4 次 SELECT → 单条聚合 `LEFT JOIN GROUP BY`
- 修复 `stats.ts` `analysis` 4 月循环查询：原 4 次循环 → 单条 `GROUP BY substr(date,1,7)`
- 修复 `stats.ts` `dashboard` / `analysis` 净资产相关子查询：单条聚合
- migration 010：DROP 4 个冗余单列索引 + 新增 `idx_subscriptions_due` partial index

### Changed
- **docs 精简**：7 份 → 5 份（120KB → 60KB，-50%）
  - 新增 `ARCHITECTURE.md`（合并 PRD + DEVELOPMENT）
  - 新增 `DATA.md`（合并 DATABASE + WORKBENCH 数据模型）
  - 重写 `API.md`（覆盖全部 80 端点）
  - 精简 `CONTRIBUTING.md` / `TESTING.md`
  - 删除 `PRD.md` / `DATABASE.md` / `DEVELOPMENT.md` / `WORKBENCH.md` / `WORKSTATION_UPGRADE.md`
- 新增 `scripts/gen-api-docs.ts`：从 routes/*.ts 自动生成端点表
- 新增 `server/src/lib/response.ts` + `error-codes.ts`：统一响应包装 helper
- 全局 `onSend` 钩子：自动包装未包装响应；跳过 `/health`、文件下载、静态资源

### Removed
- 前端死代码清理：`views/Transactions.vue` / `Stats.vue` / `Analysis.vue` / `Memories.vue`（已被 `/ledger` 替代）
- 前端未引用组件：`components/Toast.vue` / `ConfirmModal.vue`

### Fixed
- `App.vue:90` 双层 `.value.value` 解包 bug
- `router/index.ts` 守卫绕过 Pinia 直接读 localStorage → 改用 `useAuthStore().token`
- onSend 钩子保护 `/health`（避免破坏外部探针）和 `Content-Disposition: attachment` 文件下载

### Added
- `CHANGELOG.md`（本文件）

### Migration
- DB 自动应用 migration 009（token_version）和 migration 010（清理索引 + 新 partial index）
- 不需要手动操作

---

## [v0.3.2] - 2026-08-26

### Fixed
- 管理面板手机端菜单适配
- 容器构建网络问题 + 代理参数化

## [v0.3.1] - 2026-08-26

### Fixed
- 现有功能完善（7 项问题修复）

## [v0.3.0] - 2026-08-26

### Added
- 管理面板改为左侧菜单 + 右侧内容布局
- 资产全景页（`/api/assets/*`）
- 财务目标页（`/api/goals/*`）

## [v0.2.x] - 2026-07~08

### Added
- 订阅管理（`/api/subscriptions/*`）
- AI 全局记忆（`/api/memories/*`）
- Financial Analysis（过去/现在/未来三维度）
- Dashboard 仪表盘（净资产 / 趋势 / 异常提醒）
- 通知记账规则云控（`/api/config/notification-rules`）

## [v0.1.0] - 2026-07-08

### Added
- 核心功能：注册/登录、AI 记账、手动记账、流水列表
- 统计概览、预算管理
- CSV 导入（微信 / 支付宝）
- 数据导出（JSON / CSV）
- 回收站（软删除 30 天保留）