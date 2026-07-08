<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import api from '@/api/index'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<Message[]>([])
const input = ref('')
const loading = ref(false)
const sessionId = ref<string | null>(null)
const sessions = ref<any[]>([])
const showSessions = ref(false)
const chatContainer = ref<HTMLElement | null>(null)

onMounted(() => fetchSessions())

async function fetchSessions() {
  try {
    const { data } = await api.get('/ai/sessions')
    if (data.code === 0) sessions.value = data.data.items
  } catch { /* ignore */ }
}

async function sendMessage() {
  if (!input.value.trim() || loading.value) return

  const userMessage = input.value.trim()
  messages.value.push({ role: 'user', content: userMessage })
  input.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    const { data } = await api.post('/ai/chat', {
      message: userMessage,
      session_id: sessionId.value || undefined,
    }, { timeout: 30000 })

    if (data.code === 0) {
      sessionId.value = data.data.session_id
      messages.value.push({ role: 'assistant', content: data.data.message })
    } else {
      messages.value.push({ role: 'assistant', content: `⚠️ ${data.message}` })
    }
  } catch (e: any) {
    messages.value.push({
      role: 'assistant',
      content: `⚠️ ${e.response?.data?.message || '请求失败，请稍后再试'}`,
    })
  } finally {
    loading.value = false
    await scrollToBottom()
    fetchSessions()
  }
}

function newSession() {
  messages.value = []
  sessionId.value = null
  showSessions.value = false
}

async function loadSession(sid: string) {
  sessionId.value = sid
  showSessions.value = false
  // 这里简化处理，不加载历史消息（后端会自动带上下文）
  messages.value = [{ role: 'assistant', content: '已切换到该对话，请继续提问。' }]
}

async function deleteSession(sid: string) {
  try {
    await api.delete(`/ai/sessions/${sid}`)
    sessions.value = sessions.value.filter((s) => s.session_id !== sid)
    if (sessionId.value === sid) newSession()
  } catch { /* ignore */ }
}

async function scrollToBottom() {
  await nextTick()
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  }
}
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-4rem)]">
    <!-- 顶部栏 -->
    <div class="bg-white px-4 py-3 border-b border-gray-200 flex items-center justify-between">
      <h2 class="text-sm font-medium text-gray-800">AI 助手</h2>
      <div class="flex gap-2">
        <button
          @click="showSessions = !showSessions"
          class="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border rounded"
        >
          历史
        </button>
        <button
          @click="newSession"
          class="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 border border-blue-200 rounded"
        >
          新对话
        </button>
      </div>
    </div>

    <!-- 历史对话列表 -->
    <div v-if="showSessions" class="bg-white border-b border-gray-200 px-4 py-2 max-h-48 overflow-y-auto">
      <div v-if="sessions.length === 0" class="text-xs text-gray-400 py-2">暂无历史对话</div>
      <div
        v-for="s in sessions"
        :key="s.session_id"
        class="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0"
      >
        <button
          @click="loadSession(s.session_id)"
          class="text-xs text-gray-700 hover:text-blue-600 truncate flex-1 text-left"
        >
          {{ s.first_message?.slice(0, 30) || '对话' }}
        </button>
        <button
          @click="deleteSession(s.session_id)"
          class="text-xs text-gray-300 hover:text-red-500 ml-2"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 消息区域 -->
    <div ref="chatContainer" class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      <!-- 欢迎消息 -->
      <div v-if="messages.length === 0" class="text-center py-12">
        <div class="text-3xl mb-3">🤖</div>
        <p class="text-sm text-gray-500 mb-4">你好！我可以帮你：</p>
        <div class="space-y-1 text-xs text-gray-400">
          <p>• 分析消费习惯</p>
          <p>• 回答财务问题</p>
          <p>• 给出预算建议</p>
        </div>
        <div class="mt-6 space-y-2">
          <button
            v-for="q in ['这个月花了多少？', '哪个分类花得最多？', '和上个月相比怎么样？']"
            :key="q"
            @click="input = q; sendMessage()"
            class="block mx-auto px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-full hover:bg-blue-50"
          >
            {{ q }}
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="flex"
        :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap"
          :class="msg.role === 'user'
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-800'"
        >
          {{ msg.content }}
        </div>
      </div>

      <!-- 加载动画 -->
      <div v-if="loading" class="flex justify-start">
        <div class="bg-gray-100 px-3 py-2 rounded-lg text-sm text-gray-400">
          思考中...
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="bg-white border-t border-gray-200 px-4 py-3">
      <form @submit.prevent="sendMessage" class="flex gap-2">
        <input
          v-model="input"
          type="text"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="输入你的问题..."
          :disabled="loading"
        />
        <button
          type="submit"
          :disabled="loading || !input.trim()"
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          发送
        </button>
      </form>
    </div>
  </div>
</template>
