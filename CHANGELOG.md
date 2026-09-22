# Changelog

所有版本变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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