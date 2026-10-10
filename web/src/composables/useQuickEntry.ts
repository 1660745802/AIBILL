import { reactive } from 'vue'

/**
 * 快速录入的开关（模块级单例）。
 *
 * 为什么不做成组件内部状态：触发方散在三个地方——
 * App.vue 的全局快捷键、侧栏的「记一笔」按钮、手机右下 FAB，
 * 接收方也有两处（弹层本身，以及已经站在 / 页面时的输入框聚焦）。
 *
 * 关键是 state 必须在**模块作用域**而不是函数体内：
 * 在函数体内 new 一个 reactive，每次调用都是一个独立实例，
 * 打开的按钮和渲染的弹层根本不是同一个状态。
 */
export const QUICK_DRAFT_KEY = 'bill.quick-draft'

const state = reactive({ open: false })

export function useQuickEntry() {
  return {
    state,
    open: () => { state.open = true },
    close: () => { state.open = false },
  }
}
