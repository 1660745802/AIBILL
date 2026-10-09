<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * 浮层。手机 = 底部抽屉（带拖拽条、吸顶标题、吸底操作栏）；桌面 = 居中弹窗。
 * 打开时锁定 body 滚动；Esc 关闭；点遮罩关闭。
 */
const props = withDefaults(defineProps<{
  show: boolean
  title?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** 点遮罩关闭（表单类默认关闭，确认类保持 true） */
  dismissible?: boolean
  /** 吸底操作栏 */
  footer?: boolean
}>(), { title: '', size: 'md', dismissible: true, footer: false })

const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.show && props.dismissible) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))

watch(() => props.show, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
})
onUnmounted(() => { document.body.style.overflow = '' })
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      leave-active-class="transition-opacity duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="show" class="modal-root" @click.self="dismissible && emit('close')">
        <Transition
          appear
          enter-active-class="modal-panel-in"
          leave-active-class="modal-panel-out"
        >
          <div
            class="modal-panel"
            :class="[`modal-${size}`, { 'modal-has-footer': footer }]"
            role="dialog"
            aria-modal="true"
            @click.stop
          >
            <!-- 手机抽屉拖拽条 -->
            <div class="modal-grab" />

            <header v-if="title || $slots.header" class="modal-head">
              <slot name="header">
                <h2 class="modal-title">{{ title }}</h2>
              </slot>
              <button
                type="button"
                class="modal-close"
                aria-label="关闭"
                @click="emit('close')"
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
  inset: 0;
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
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: var(--color-paper-raised);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
@media (min-width: 768px) {
  .modal-panel {
    max-height: 85dvh;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-rule);
  }
  .modal-grab { display: none; }
}

.modal-grab {
  width: 2rem;
  height: 3px;
  border-radius: 999px;
  background: var(--color-rule-strong);
  margin: 0.5rem auto 0;
  flex-shrink: 0;
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

.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}
.modal-foot {
  padding: 0.875rem 1rem;
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
