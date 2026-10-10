<script setup lang="ts">
import AppIcon from './AppIcon.vue'

/**
 * 空态：图标 + 一句说明 + 一个明确的下一步动作。
 * 永远给出方向，不写「暂无数据」了事。
 */
withDefaults(defineProps<{
  icon?: string
  title: string
  description?: string
  /** 背景铺极淡刻度网格（空面板） */
  ruled?: boolean
  compact?: boolean
}>(), { icon: 'inbox', description: '', ruled: false, compact: false })
</script>

<template>
  <div
    class="empty"
    :class="[ruled ? 'paper-ruled' : '', compact ? 'empty-compact' : '']"
  >
    <div class="empty-icon">
      <AppIcon :name="icon" :size="compact ? 18 : 22" :stroke="1.5" />
    </div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-action"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2.75rem 1.25rem;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-rule-strong);
}
.empty-compact { padding: 1.75rem 1rem; }
.empty-icon {
  width: 2.5rem;
  height: 2.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--color-paper-sunk);
  color: var(--color-ink-4);
  margin-bottom: 0.875rem;
}
.empty-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-ink-2);
}
.empty-desc {
  font-size: 0.75rem;
  color: var(--color-ink-3);
  margin-top: 0.3125rem;
  max-width: 22rem;
  line-height: 1.55;
}
.empty-action { margin-top: 1.125rem; }
</style>
