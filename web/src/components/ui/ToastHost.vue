<script setup lang="ts">
import { useToast } from '@/composables/useToast'
import AppIcon from './AppIcon.vue'

const toast = useToast()

const ICON: Record<string, string> = {
  success: 'check',
  error: 'close',
  warning: 'alert',
  info: 'info',
}
const BAR: Record<string, string> = {
  success: 'var(--color-income)',
  error: 'var(--color-expense)',
  warning: 'var(--color-warn)',
  info: 'var(--color-ink-3)',
}
</script>

<template>
  <Teleport to="body">
    <div
      class="toast-host"
      role="status"
      aria-live="polite"
    >
      <TransitionGroup
        enter-active-class="transition-all duration-260 ease-out"
        leave-active-class="transition-all duration-160 ease-in absolute"
        enter-from-class="opacity-0 translate-y-2"
        leave-to-class="opacity-0 scale-95"
      >
        <button
          v-for="t in toast.toasts.value"
          :key="t.id"
          type="button"
          class="toast"
          :style="{ borderLeftColor: BAR[t.type] }"
          @click="toast.dismiss(t.id)"
        >
          <AppIcon :name="ICON[t.type] ?? 'info'" :size="14" :stroke="2.2" class="shrink-0" />
          <span class="flex-1 text-left">{{ t.message }}</span>
        </button>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 0.75rem;
  right: 0.75rem;
  /* 避开移动端底部导航 + 安全区 */
  bottom: calc(4.75rem + env(safe-area-inset-bottom, 0px) + 0.5rem);
  z-index: 300;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  pointer-events: none;
}
@media (min-width: 768px) {
  .toast-host {
    top: 1rem;
    bottom: auto;
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: min(24rem, 92vw);
    align-items: stretch;
  }
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  max-width: 22rem;
  padding: 0.5625rem 0.75rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-rule);
  border-left-width: 3px;
  background: var(--color-paper-raised);
  color: var(--color-ink-1);
  font-size: 0.8125rem;
  font-weight: 500;
  box-shadow: var(--shadow-pop);
  cursor: pointer;
}
</style>
