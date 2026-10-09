<script setup lang="ts">
/** 标签输入：回车或逗号提交，自动提示已有标签。 */
import { ref, onMounted, computed } from 'vue'
import api from '@/api/index'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [tags: string[]] }>()

const inputText = ref('')
const allTags = ref<string[]>([])
const open = ref(false)

onMounted(async () => {
  try {
    const { data } = await api.get('/transactions/tags')
    if (data.code === 0) allTags.value = data.data.items
  } catch { /* ignore */ }
})

const suggestions = computed(() =>
  allTags.value
    .filter((t) => !props.modelValue.includes(t))
    .filter((t) => !inputText.value || t.includes(inputText.value))
    .slice(0, 5),
)

function addTag(tag: string) {
  const t = tag.trim().replace(/^#/, '')
  if (!t || props.modelValue.includes(t)) { inputText.value = ''; open.value = false; return }
  emit('update:modelValue', [...props.modelValue, t])
  inputText.value = ''
  open.value = false
}

function removeTag(tag: string) {
  emit('update:modelValue', props.modelValue.filter((t) => t !== tag))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault()
    addTag(inputText.value)
  } else if (e.key === 'Backspace' && !inputText.value && props.modelValue.length) {
    const last = props.modelValue[props.modelValue.length - 1]
    if (last) removeTag(last)
  }
}
</script>

<template>
  <div class="relative">
    <div v-if="modelValue.length" class="flex flex-wrap gap-1.5 mb-1.5">
      <span v-for="tag in modelValue" :key="tag" class="badge">
        <span class="truncate max-w-[9rem]">{{ tag }}</span>
        <button
          type="button"
          class="ml-0.5 opacity-50 hover:opacity-100 transition"
          :aria-label="`移除标签 ${tag}`"
          @click="removeTag(tag)"
        >
          <AppIcon name="close" :size="10" :stroke="2.4" />
        </button>
      </span>
    </div>

    <input
      v-model="inputText"
      type="text"
      class="field"
      placeholder="输入标签，回车添加"
      @keydown="onKeydown"
      @focus="open = true"
      @blur="open = false"
    />

    <ul
      v-if="open && suggestions.length"
      class="absolute z-20 mt-1 w-full max-h-32 overflow-y-auto surface surface-flush py-1"
      style="box-shadow: var(--shadow-pop)"
    >
      <li v-for="tag in suggestions" :key="tag">
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 text-xs hover:bg-paper-hover transition-colors"
          style="color: var(--color-ink-2)"
          @mousedown.prevent="addTag(tag)"
        >{{ tag }}</button>
      </li>
    </ul>
  </div>
</template>
