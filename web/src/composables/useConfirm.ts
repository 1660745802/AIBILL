/**
 * 全局确认框。替换原生 confirm()——原生弹窗与本产品的界面语言完全割裂，
 * 且无法说明「删除之后会发生什么」。
 *
 * 用法：
 *   const confirm = useConfirm()
 *   if (!(await confirm({ title: '删除目标', body: '「买车」及其进度将被移除。', danger: true }))) return
 */
import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  /** 说明后果，不要只写「确定吗」 */
  body?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认按钮改用描边红 */
  danger?: boolean
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export const confirmState = ref<Pending | null>(null)

export function useConfirm() {
  return function confirm(opts: ConfirmOptions): Promise<boolean> {
    if (confirmState.value) {
      confirmState.value.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      confirmState.value = {
        ...opts,
        confirmText: opts.confirmText ?? (opts.danger ? '删除' : '确定'),
        cancelText: opts.cancelText ?? '取消',
        resolve,
      }
    })
  }
}

export function resolveConfirm(ok: boolean) {
  const p = confirmState.value
  if (!p) return
  confirmState.value = null
  p.resolve(ok)
}
