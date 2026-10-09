<script setup lang="ts">
/** 栏头：文字 + 延伸到底的发丝线（账本栏目线）。 */
withDefaults(defineProps<{
  /** solid=true 时不画线（用于右对齐数值等） */
  solid?: boolean
  count?: number | null
}>(), { solid: false, count: null })
</script>

<template>
  <div class="flex items-center gap-2.5 mb-3">
    <span class="ledger-label" :class="solid ? 'ledger-label-solid' : ''">
      <slot />
      <span v-if="count !== null" class="badge">{{ count }}</span>
    </span>
    <slot name="end" />
  </div>
</template>
