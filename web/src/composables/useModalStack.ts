import { shallowRef } from 'vue'

/**
 * 浮层栈。多个 BaseModal 可能同时存在（编辑弹窗上再弹一个确认框）。
 * 栈同时控制 Esc、视觉层级与 body 滚动锁，避免上下两层各自为政。
 */
const stack = shallowRef<symbol[]>([])
let previousBodyOverflow: string | null = null

function syncBodyLock() {
  if (typeof document === 'undefined') return
  if (stack.value.length > 0) {
    if (previousBodyOverflow === null) previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return
  }
  if (previousBodyOverflow !== null) {
    document.body.style.overflow = previousBodyOverflow
    previousBodyOverflow = null
  }
}

export function pushModal(id: symbol) {
  if (!stack.value.includes(id)) stack.value = [...stack.value, id]
  syncBodyLock()
}

export function removeModal(id: symbol) {
  if (stack.value.includes(id)) stack.value = stack.value.filter((item) => item !== id)
  syncBodyLock()
}

export function isTopModal(id: symbol): boolean {
  return stack.value[stack.value.length - 1] === id
}

/** 每层相差 10，保证后打开的确认框画在已有编辑弹窗之上。 */
export function modalZIndex(id: symbol): number {
  const index = stack.value.indexOf(id)
  return 200 + Math.max(index, 0) * 10
}
