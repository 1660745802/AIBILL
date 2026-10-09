<script setup lang="ts">
withDefaults(defineProps<{
  options: { value: string; label: string }[]
  modelValue: string
  size?: 'sm' | 'md'
  /** 横向滚动（项多时用） */
  scroll?: boolean
}>(), { size: 'md', scroll: false })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div
    class="segmented"
    :class="[scroll ? 'flex w-max' : '', size === 'sm' ? 'segmented-sm' : '']"
    role="tablist"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.value"
      class="segmented-item"
      :class="modelValue === opt.value ? 'segmented-item-active' : ''"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented-sm .segmented-item { padding: 0.25rem 0.5625rem; font-size: 0.75rem; }
</style>
