<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(defineProps<{
  tone?: 'neutral' | 'warn' | 'danger' | 'info' | 'success'
  /** 省略图标时用纯文本条 */
  dense?: boolean
}>(), { tone: 'neutral', dense: false })

const emit = defineEmits<{ close: [] }>()

const ICON: Record<string, string> = {
  neutral: 'info',
  warn: 'alert',
  danger: 'alert',
  info: 'info',
  success: 'check',
}
</script>

<template>
  <div class="notice" :class="`notice-${tone}`" role="status">
    <AppIcon :name="ICON[tone] ?? 'info'" :size="15" :stroke="1.9" class="mt-[1px]" />
    <div class="flex-1 min-w-0">
      <slot />
    </div>
    <button
      v-if="$slots.close"
      type="button"
      class="shrink-0 opacity-50 hover:opacity-100 transition"
      aria-label="关闭"
      @click="emit('close')"
    >
      <AppIcon name="close" :size="13" />
    </button>
  </div>
</template>
