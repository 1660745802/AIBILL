<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * 周期切换 ‹ 2026年9月 ›。
 * 内部维护 year / month，支持跨年；可禁用未来月份。
 */
const props = withDefaults(defineProps<{
  year: number
  month: number
  /** 禁止翻到未来（默认禁止） */
  disableFuture?: boolean
}>(), { disableFuture: true })

const emit = defineEmits<{ change: [year: number, month: number] }>()

const label = computed(() => `${props.year}年${props.month}月`)

const now = new Date()
const atCurrentMonth = computed(
  () => props.year === now.getFullYear() && props.month === now.getMonth() + 1,
)

function step(delta: number) {
  let y = props.year
  let m = props.month + delta
  if (m < 1) { m = 12; y-- }
  if (m > 12) { m = 1; y++ }
  if (props.disableFuture && (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1))) return
  emit('change', y, m)
}
</script>

<template>
  <div class="period">
    <button
      type="button"
      class="period-step"
      aria-label="上个月"
      @click="step(-1)"
    >
      <AppIcon name="chevronLeft" :size="16" />
    </button>
    <span class="period-label amt">{{ label }}</span>
    <button
      type="button"
      class="period-step"
      aria-label="下个月"
      :disabled="disableFuture && atCurrentMonth"
      @click="step(1)"
    >
      <AppIcon name="chevronRight" :size="16" />
    </button>
  </div>
</template>

<style scoped>
.period {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper-raised);
  overflow: hidden;
}
.period-step {
  width: 2rem;
  height: 2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-3);
  transition: background-color 0.13s ease, color 0.13s ease;
}
.period-step:hover:not(:disabled) {
  background: var(--color-paper-hover);
  color: var(--color-ink-1);
}
.period-step:disabled { opacity: 0.3; cursor: not-allowed; }
.period-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-ink-1);
  padding: 0 0.5rem;
  min-width: 5.75rem;
  text-align: center;
  border-inline: 1px solid var(--color-rule-faint);
  line-height: 2rem;
}
</style>
