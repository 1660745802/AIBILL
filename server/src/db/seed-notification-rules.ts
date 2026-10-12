/**
 * 通知规则启动发布（薄封装）
 *
 * 真源已改为仓库文件 `server/config/rules.json`（发布/回滚见 docs/ARCHITECTURE.md §3.7），本文件不再内置规则内容，
 * 只把「启动时发布」这件事委托给 `publishRulesFromFile`：
 *   load → validate → testcases 自检 → content hash → 与激活版本比对（幂等）。
 *
 * 保留函数名 `ensureDefaultNotificationRules`，`app.ts` 调用点不必改；
 * 但语义已从「表为空才插默认」变为「按文件发布/对齐」，且校验失败会 **fail-fast**。
 */
import { getDb } from './index.js'
import { config } from '../config.js'
import { publishRulesFromFile } from '../lib/notification-rules.js'

export function ensureDefaultNotificationRules(): void {
  const result = publishRulesFromFile(getDb(), config.rulesPath)
  if (result.published) {
    console.log(`[App] Notification rules published from file (v${result.version})`)
  } else {
    console.log(`[App] Notification rules up-to-date (v${result.version})`)
  }
}
