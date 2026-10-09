<script setup lang="ts">
import { icons } from './icons'

withDefaults(defineProps<{
  name: string
  size?: number
  stroke?: number
}>(), {
  size: 18,
  stroke: 1.75,
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="stroke"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path :d="icons[name] ?? icons.info" />
  </svg>
</template>
