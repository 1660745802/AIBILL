<script setup lang="ts">
/** 账本表格行：行间只有一条发丝线，没有框。 */
defineProps<{
  clickable?: boolean
  active?: boolean
}>()
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    class="sheet-row"
    :class="[clickable ? 'sheet-row-click' : '', active ? 'sheet-row-active' : '']"
    :type="clickable ? 'button' : undefined"
  >
    <slot />
  </component>
</template>
