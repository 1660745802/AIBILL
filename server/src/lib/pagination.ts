/**
 * 分页参数解析 —— 全仓唯一实现。
 *
 * 为什么必须有这个函数：`?page=abc` 曾经在各个列表接口里各自写成
 * `Math.max(1, parseInt(...))` → 得到 **NaN** 或 **Infinity**，
 * 一路绑进 SQL 的 `LIMIT ? OFFSET ?`，better-sqlite3 直接抛
 * `SqliteError: datatype mismatch` → 客户端拿到 500。
 * （`Number('1e999')` 是 Infinity，比 NaN 更隐蔽：`Number(x) || 1` 挡不住它。）
 *
 * 口径：非法值回落默认值，合法值收敛到 [1, max]。不要静默当成 0 或负数。
 */

/** 单个分页参数：`raw` 非法（空串 / NaN / Infinity / 非数字）时回落到 `fallback` */
export function pageParam(raw: string | undefined, fallback: number, max: number): number {
  // 空串/未传 = 没给这个参数 → 用默认值（不要当成 0，否则会变成第 1 页/每页 1 条）
  if (raw == null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}
