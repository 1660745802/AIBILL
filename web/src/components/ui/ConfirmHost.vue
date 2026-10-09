<script setup lang="ts">
import { computed } from 'vue'
import { confirmState, resolveConfirm } from '@/composables/useConfirm'
import BaseModal from './BaseModal.vue'
import AppIcon from './AppIcon.vue'

const open = computed(() => !!confirmState.value)
const danger = computed(() => !!confirmState.value?.danger)
</script>

<template>
  <BaseModal
    :show="open"
    size="sm"
    :dismissible="false"
    @close="resolveConfirm(false)"
  >
    <div class="flex gap-3">
      <div
        class="w-8 h-8 rounded flex items-center justify-center shrink-0"
        :style="danger
          ? 'background: var(--color-expense-soft); color: var(--color-expense)'
          : 'background: var(--color-paper-sunk); color: var(--color-ink-3)'"
      >
        <AppIcon :name="danger ? 'trash' : 'info'" :size="16" />
      </div>
      <div class="min-w-0 flex-1 pt-0.5">
        <h3 class="text-sm font-semibold" style="color: var(--color-ink-1)">
          {{ confirmState?.title }}
        </h3>
        <p v-if="confirmState?.body" class="text-xs mt-1.5 leading-relaxed" style="color: var(--color-ink-3)">
          {{ confirmState.body }}
        </p>
      </div>
    </div>

    <div class="flex gap-2 mt-5">
      <button class="btn btn-outline flex-1" @click="resolveConfirm(false)">
        {{ confirmState?.cancelText }}
      </button>
      <button
        class="btn flex-1"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        @click="resolveConfirm(true)"
      >
        {{ confirmState?.confirmText }}
      </button>
    </div>
  </BaseModal>
</template>
