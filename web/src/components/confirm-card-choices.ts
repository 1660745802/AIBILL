/**
 * 确认卡里「用户选了什么」的**纯函数**（不碰 DOM，可单测）
 *
 * ## 背景：Vue3 下 `<option :value="null">` 的真实值是空串
 *
 * Vue3 的 `patchDOMProp` 对 `value` 做的是 `el._value = value; el.value = (value == null ? '' : value)`
 * —— 所以 `<option :value="null">未归类</option>` 在 DOM 上是 `value=""`。
 * 旧代码写的是 `Number($event.target.value)`：`Number("")` = **0**，
 * `categories.find(c => c.id === 0)` = undefined，`if (cat && item)` 就不赋值 ——
 * **用户的操作被静默吞掉**：一行本来归到了分类 5，点「未归类」什么都不会发生。
 * 而且 `Number()` 把「选 null」和「选 id=0」压成同一个值，靠「schema 不允许 id=0」
 * 的巧合兜着，不是类型保证。
 *
 * ## 为什么这里不再用 `Number()`
 *
 * `Number('')` → 0、`Number(null)` → 0，两种语义被压成同一个数字；而 id 是不是 0
 * 属于**别的层**（DB 自增主键）的事实，不该由这一层去依赖。改成：
 *   1. 先判空（空串 / null / undefined = 用户选了那个「空」选项）；
 *   2. 再把非空串解析成整数，并**校验**是正整数，否则按「无效选择」处理；
 *   3. 选空 → **真的把字段清掉**（category_id=null、名字/图标置空），而不是 no-op。
 *
 * 顺带修了账户下拉的同一个 bug（`<option :value="null">未指定</option>` + `Number()`
 * 是同一个错的两份拷贝，其中一份在 main 上就存在）。
 */
import type { AccountRef, CategoryRef, ParsedItem } from './confirm-card-types'

/** 用户在下拉里选的东西：DOM 读出的字符串，或调用方直接给的 id */
export type ChoiceValue = string | number | null | undefined

/**
 * 把 `<select>` 的 DOM value 解析成「选中的 id」，**空 = 没选（那个 null 选项）**。
 *
 * 纯函数：不认识 DOM，只做字符串 → id 的判定，所以能被单测直接覆盖
 * （web 目前零测试框架，见交付说明）。
 */
export function choiceId(raw: ChoiceValue): number | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (trimmed === '') return null
  const id = Number(trimmed)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * 把「用户选的分类」应用到 item 上。
 *
 * - 选空（未归类）→ category_id=null、category_name=''、category_icon=''
 *   （服务端契约里这三者必须同时为空，见 category-matcher 的 CategoryResolution）
 * - 选了 id 但找不到该分类（用户分类已被删）→ 不动 item（宁可保持原样，也不写脏数据）
 */
export function applyCategoryChoice(
  item: ParsedItem,
  choice: ChoiceValue,
  categories: readonly CategoryRef[],
): void {
  const id = choiceId(choice)
  if (id === null) {
    item.category_id = null
    item.category_name = ''
    item.category_icon = ''
    return
  }
  const cat = categories.find((c) => c.id === id)
  if (cat) Object.assign(item, { category_id: cat.id, category_name: cat.name, category_icon: cat.icon })
}

/** 同上，账户维度（选「未指定」→ account_id=null、account_name=''） */
export function applyAccountChoice(
  item: ParsedItem,
  choice: ChoiceValue,
  accounts: readonly AccountRef[],
): void {
  const id = choiceId(choice)
  if (id === null) {
    item.account_id = null
    item.account_name = ''
    return
  }
  const acc = accounts.find((a) => a.id === id)
  if (acc) Object.assign(item, { account_id: acc.id, account_name: acc.name })
}