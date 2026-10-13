/**
 * 确认卡的行级共享类型（ConfirmCards / ConfirmCardRow 共用一份，避免各写各的）
 *
 * 口径：`ParsedItem` 就是 `POST /api/ai/parse` 出参里 `items[]` 的形状，一字不改。
 *
 * ⚠️ 服务端 Step 4 追加的 `category_reason` / `noise_term` / `noise_verdict_source`
 * 是**纯审计字段**（给管理员复核用），这里**刻意不声明**：前端渲染不依赖它们，
 * 声明了反而会让人以为「前端要用它做点什么」。
 */

export interface ParsedItem {
  type: string
  amount: number
  category_id: number | null
  category_name: string
  category_icon: string
  description: string
  date: string
  account_id: number | null
  account_name: string
  target_account_id?: number | null
  target_account_name?: string
}

/** 分类下拉的最小形状（GET /api/categories 的 items[]） */
export interface CategoryRef {
  id: number
  name: string
  type: string
  icon: string
}

/** 账户下拉的最小形状（GET /api/accounts 的 items[]） */
export interface AccountRef {
  id: number
  name: string
  icon: string
}