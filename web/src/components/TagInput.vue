<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api/index'

const props = defineProps<{
  modelValue: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [tags: string[]]
}>()

const inputText = ref('')
const allTags = ref<string[]>([])
const showSuggestions = ref(false)

onMounted(async () => {
  try {
    const { data } = await api.get('/transactions/tags')
    if (data.code === 0) allTags.value = data.data.items
  } catch { /* ignore */ }
})

function addTag(tag: string) {
  const t = tag.trim()
  if (!t || props.modelValue.includes(t)) return
  emit('update:modelValue', [...props.modelValue, t])
  inputText.value = ''
  showSuggestions.value = false
}

function removeTag(tag: string) {
  emit('update:modelValue', props.modelValue.filter((t) => t !== tag))
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addTag(inputText.value)
  }
}

const filteredSuggestions = ref<string[]>([])
function handleInput() {
  showSuggestions.value = true
  filteredSuggestions.value = allTags.value
    .filter((t) => t.includes(inputText.value) && !props.modelValue.includes(t))
    .slice(0, 5)
}
</script>

<template>
  <div class="relative">
    <!-- 已选标签 -->
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-1 mb-1.5">
      <span
        v-for="tag in modelValue"
        :key="tag"
        class="inline-flex items-center gap-0.5 px-2 py-0.5 bg-blue-50 text-blue-600 text-xs rounded-full"
      >
        #{{ tag }}
        <button @click="removeTag(tag)" class="text-blue-400 hover:text-blue-700 ml-0.5">&times;</button>
      </span>
    </div>

    <!-- 输入框 -->
    <input
      v-model="inputText"
      type="text"
      class="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      placeholder="输入标签，回车添加"
      @keydown="handleKeydown"
      @input="handleInput"
      @focus="handleInput"
      @blur="setTimeout(() => showSuggestions = false, 150)"
    />

    <!-- 建议列表 -->
    <div
      v-if="showSuggestions && filteredSuggestions.length > 0"
      class="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-sm max-h-32 overflow-y-auto"
    >
      <button
        v-for="tag in filteredSuggestions"
        :key="tag"
        class="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        @mousedown.prevent="addTag(tag)"
      >
        #{{ tag }}
      </button>
    </div>
  </div>
</template>
