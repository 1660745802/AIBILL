<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { pushModal, removeModal, isTopModal, modalZIndex } from '@/composables/useModalStack'

/**
 * 浮层。手机 = 底部抽屉（带拖拽条、吸顶标题、吸底操作栏）；桌面 = 居中弹窗。
 * 打开时锁定 body 滚动；Esc 关闭；点遮罩关闭。
 */
const props = withDefaults(defineProps<{
  show: boolean
  title?: string
  /** 没有使用 title（例如自定义 header）时，为对话框提供可访问名称 */
  ariaLabel?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** 点遮罩关闭（表单类默认关闭，确认类保持 true） */
  dismissible?: boolean
  /** 吸底操作栏 */
  footer?: boolean
}>(), { title: '', size: 'md', dismissible: true, footer: false })

const emit = defineEmits<{ close: [] }>()

const id = Symbol('modal')
const isTop = computed(() => isTopModal(id))
const zIndex = computed(() => modalZIndex(id))
let previouslyFocused: HTMLElement | null = null

/* ── 手机抽屉：下拉关闭 ──
   拖拽条以前只是装饰，看起来能拖、实际拖不动——外观在撒谎。
   现在按住拖拽条往下拉：超过阈值就关，不够就回弹。
   不可关闭的浮层（dismissible=false）只回弹，不关。 */
const panel = ref<HTMLElement | null>(null)
let dragStartY: number | null = null
let dragDy = 0
const DISMISS_DISTANCE = 96

function onGrabDown(e: PointerEvent) {
  dragStartY = e.clientY
  dragDy = 0
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  if (panel.value) panel.value.style.transition = 'none'
}
function onGrabMove(e: PointerEvent) {
  if (dragStartY == null || !panel.value) return
  dragDy = Math.max(0, e.clientY - dragStartY) // 只允许往下拉
  panel.value.style.transform = `translateY(${dragDy}px)`
}
function resetGrab() {
  if (!panel.value) return
  panel.value.style.transition = 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)'
  panel.value.style.transform = ''
  dragStartY = null
  dragDy = 0
}
function onGrabUp() {
  if (dragStartY == null || !panel.value) return
  const shouldClose = dragDy > DISMISS_DISTANCE && props.dismissible
  resetGrab()
  if (shouldClose) emit('close')
}
function onGrabCancel() {
  if (dragStartY == null) return
  resetGrab()
}

function focusableElements(): HTMLElement[] {
  if (!panel.value) return []
  return Array.from(panel.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null)
}

function onKey(e: KeyboardEvent) {
  if (!props.show || !isTop.value) return
  if (e.key === 'Escape' && props.dismissible) {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) {
    e.preventDefault()
    panel.value?.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const active = document.activeElement
  if (!panel.value?.contains(active) || active === panel.value) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function restorePreviousFocus() {
  if (previouslyFocused?.isConnected) previouslyFocused.focus()
  previouslyFocused = null
}

function onAfterLeave() {
  if (props.show) return
  removeModal(id)
  restorePreviousFocus()
}

onMounted(() => document.addEventListener('keydown', onKey))

watch(() => props.show, async (open) => {
  if (!open) return // 离场动画结束后再出栈，避免动画期间层级和滚动锁提前失效
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  pushModal(id)
  await nextTick()
  const autofocus = panel.value?.querySelector<HTMLElement>('[autofocus]')
  ;(autofocus ?? panel.value)?.focus()
}, { immediate: true })

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  removeModal(id)
  restorePreviousFocus()
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      leave-active-class="transition-opacity duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
      @after-leave="onAfterLeave"
    >
      <div
        v-if="show"
        class="modal-root"
        :style="{ zIndex }"
        @click.self="dismissible && emit('close')"
      >
        <Transition
          appear
          enter-active-class="modal-panel-in"
          leave-active-class="modal-panel-out"
        >
          <div
            ref="panel"
            class="modal-panel"
            :class="[`modal-${size}`, { 'modal-has-footer': footer }]"
            role="dialog"
            :aria-modal="isTop ? 'true' : undefined"
            :aria-hidden="isTop ? undefined : 'true'"
            :aria-label="ariaLabel || title || '对话框'"
            :inert="!isTop"
            tabindex="-1"
            @click.stop
          >
            <!-- 手机抽屉拖拽条：可以按住往下拉关闭 -->
            <div
              class="modal-grab"
              aria-hidden="true"
              @pointerdown="onGrabDown"
              @pointermove="onGrabMove"
              @pointerup="onGrabUp"
              @pointercancel="onGrabCancel"
            />

            <header v-if="title || $slots.header" class="modal-head">
              <slot name="header">
                <h2 class="modal-title">{{ title }}</h2>
              </slot>
              <button
                type="button"
                class="modal-close"
                aria-label="关闭"
                :disabled="!dismissible"
                @click="dismissible && emit('close')"
              >
                <AppIcon name="close" :size="16" />
              </button>
            </header>

            <div class="modal-body scroll-thin">
              <slot />
            </div>

            <footer v-if="footer || $slots.footer" class="modal-foot safe-bottom">
              <slot name="footer" />
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-root {
  position: fixed;
  top: var(--app-viewport-top, 0px);
  right: auto;
  bottom: auto;
  left: var(--app-viewport-left, 0px);
  width: var(--app-viewport-width, 100vw);
  height: var(--app-viewport-height, 100dvh);
  z-index: 200;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgb(20 23 26 / 0.42);
  backdrop-filter: blur(2px);
}
@media (min-width: 768px) {
  .modal-root { align-items: center; padding: 1.5rem; }
}

.modal-panel {
  position: relative;
  width: 100%;
  max-height: min(88dvh, calc(var(--app-viewport-height, 100dvh) - 0.75rem));
  display: flex;
  flex-direction: column;
  background: var(--color-paper-raised);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
@media (min-width: 768px) {
  .modal-panel {
    max-height: min(85dvh, calc(var(--app-viewport-height, 100dvh) - 3rem));
    border-radius: var(--radius-md);
    border: 1px solid var(--color-rule);
  }
  .modal-grab { display: none; }
}

/* 视觉上是 2rem × 3px 的细条，但可按压区域是整行 —— 手指够得着才算数 */
.modal-grab {
  position: relative;
  height: 1.5rem;
  flex-shrink: 0;
  cursor: grab;
  touch-action: none;
}
.modal-grab::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0.5rem;
  width: 2rem;
  height: 3px;
  border-radius: 999px;
  background: var(--color-rule-strong);
  transform: translateX(-50%);
}
@media (pointer: coarse) and (max-width: 767px) {
  .modal-grab { height: 2.75rem; }
  .modal-grab::before { top: 1rem; }
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--color-rule);
  flex-shrink: 0;
}
.modal-title {
  font-size: 0.9375rem;
  font-weight: 650;
  color: var(--color-ink-1);
}
.modal-close {
  width: 1.75rem;
  height: 1.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  color: var(--color-ink-3);
  transition: background-color 0.13s, color 0.13s;
}
.modal-close:hover { background: var(--color-paper-hover); color: var(--color-ink-1); }
.modal-close:disabled { opacity: 0.42; cursor: not-allowed; }

.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.modal-foot {
  padding: 0.875rem 1rem calc(0.875rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--color-rule);
  background: var(--color-paper-raised);
  flex-shrink: 0;
}

.modal-sm { max-width: 22rem; }
.modal-md { max-width: 26rem; }
.modal-lg { max-width: 34rem; }
.modal-xl { max-width: 52rem; }

.modal-panel-in { animation: modal-in 0.26s cubic-bezier(0.22, 1, 0.36, 1); }
.modal-panel-out { animation: modal-out 0.16s ease-in forwards; }
@keyframes modal-in {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (min-width: 768px) {
  .modal-panel-in { animation-name: modal-in-center; }
  @keyframes modal-in-center {
    from { opacity: 0; transform: scale(0.97) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
}
@keyframes modal-out {
  to { opacity: 0; transform: translateY(16px); }
}
</style>
