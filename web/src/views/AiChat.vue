<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import api from '@/api/index'
import { useConfirm } from '@/composables/useConfirm'
import AppIcon from '@/components/ui/AppIcon.vue'

const confirm = useConfirm()

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

const suggestions = ['这个月花了多少？', '哪个分类花得最多？', '和上个月相比怎么样？']

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

function askSuggestion(q: string) {
  input.value = q
  sendMessage()
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
  if (!(await confirm({
    title: '删除对话',
    body: '该对话记录将被永久移除，无法恢复。',
    danger: true,
  }))) return
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

function onEnter(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <div class="chat-shell">
    <!-- 报头：双线压边 -->
    <header class="chat-head">
      <div class="min-w-0">
        <h1 class="chat-title">AI 助手</h1>
        <p class="chat-sub">问它关于你账目的任何问题</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          class="btn btn-outline btn-sm"
          :class="showSessions ? 'chat-head-on' : ''"
          @click="showSessions = !showSessions"
        >
          <AppIcon name="history" :size="15" />
          历史
        </button>
        <button type="button" class="btn btn-outline btn-sm" @click="newSession">
          <AppIcon name="plus" :size="15" />
          新对话
        </button>
      </div>
    </header>

    <!-- 历史面板：最多 5 条可见 + 滚动 -->
    <Transition name="fade">
      <div v-if="showSessions" class="chat-history scroll-thin">
        <div v-if="sessions.length === 0" class="px-4 py-3 text-xs text-ink-4">
          还没有历史对话
        </div>
        <div
          v-for="s in sessions"
          :key="s.session_id"
          class="chat-history-row"
        >
          <button
            type="button"
            class="flex-1 min-w-0 text-left text-xs text-ink-2 hover:text-ink-1 truncate"
            @click="loadSession(s.session_id)"
          >
            {{ s.first_message?.slice(0, 40) || '对话' }}
          </button>
          <button
            type="button"
            class="act act-danger shrink-0"
            aria-label="删除对话"
            @click="deleteSession(s.session_id)"
          >
            <AppIcon name="trash" :size="14" />
          </button>
        </div>
      </div>
    </Transition>

    <!-- 消息区 -->
    <div ref="chatContainer" class="chat-body scroll-thin">
      <!-- 空态：一句引导 + 建议问题 chip -->
      <div v-if="messages.length === 0" class="chat-empty">
        <div class="chat-empty-mark">
          <AppIcon name="spark" :size="22" :stroke="1.6" />
        </div>
        <p class="chat-empty-title">我能基于你的账目回答问题</p>
        <p class="chat-empty-desc">试试直接问我这个月的消费情况，或点下面的问题开始。</p>
        <div class="mt-5 flex flex-col items-center gap-2">
          <button
            v-for="q in suggestions"
            :key="q"
            type="button"
            class="chip"
            @click="askSuggestion(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <div class="chat-stream">
        <div
          v-for="(msg, i) in messages"
          :key="i"
          class="flex"
          :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="chat-bubble"
            :class="msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'"
          >{{ msg.content }}</div>
        </div>

        <!-- 等待：三点动画 -->
        <div v-if="loading" class="flex justify-start">
          <div class="chat-bubble chat-bubble-ai chat-typing">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区：吸底 -->
    <div class="chat-input-bar safe-bottom">
      <form class="chat-input-form" @submit.prevent="sendMessage">
        <textarea
          v-model="input"
          rows="1"
          class="field chat-textarea scroll-thin"
          placeholder="输入你的问题…"
          :disabled="loading"
          @keydown="onEnter"
        ></textarea>
        <button
          type="submit"
          class="btn btn-primary btn-icon shrink-0"
          :disabled="loading || !input.trim()"
          aria-label="发送"
        >
          <AppIcon name="send" :size="17" />
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.chat-shell {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  max-width: 56rem;
  margin-inline: auto;
  width: 100%;
}

.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--color-paper);
  border-bottom: 3px double var(--color-rule-strong);
  flex-shrink: 0;
}
.chat-title {
  font-size: 1.0625rem;
  font-weight: 650;
  color: var(--color-ink-1);
  line-height: 1.3;
}
.chat-sub {
  font-size: 0.75rem;
  color: var(--color-ink-3);
  margin-top: 0.0625rem;
}
.chat-head-on {
  background: var(--color-paper-hover);
  border-color: var(--color-ink-3);
  color: var(--color-ink-1);
}

.chat-history {
  flex-shrink: 0;
  max-height: 13rem;
  overflow-y: auto;
  background: var(--color-paper-raised);
  border-bottom: 1px solid var(--color-rule);
}
.chat-history-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  border-top: 1px solid var(--color-rule-faint);
}
.chat-history-row:first-child { border-top: 0; }

.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1rem;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-height: 100%;
  padding: 2rem 1rem;
}
.chat-empty-mark {
  width: 3rem;
  height: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-paper-sunk);
  color: var(--color-ink-3);
  margin-bottom: 1rem;
}
.chat-empty-title {
  font-size: 0.9375rem;
  font-weight: 650;
  color: var(--color-ink-1);
}
.chat-empty-desc {
  font-size: 0.8125rem;
  color: var(--color-ink-3);
  margin-top: 0.375rem;
  max-width: 20rem;
  line-height: 1.55;
}

.chat-stream { display: flex; flex-direction: column; gap: 0.75rem; }

.chat-bubble {
  max-width: 80%;
  padding: 0.625rem 0.8125rem;
  font-size: 0.875rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-bubble-user {
  background: var(--color-action);
  color: var(--color-action-fg);
  border-radius: var(--radius-md) var(--radius-md) var(--radius-xs) var(--radius-md);
}
.chat-bubble-ai {
  background: var(--color-paper-raised);
  color: var(--color-ink-1);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md) var(--radius-md) var(--radius-md) var(--radius-xs);
}

/* 三点等待动画 */
.chat-typing {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.chat-typing span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-ink-4);
  animation: chat-dot 1.2s infinite ease-in-out;
}
.chat-typing span:nth-child(2) { animation-delay: 0.18s; }
.chat-typing span:nth-child(3) { animation-delay: 0.36s; }
@keyframes chat-dot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

.chat-input-bar {
  flex-shrink: 0;
  padding: 0.75rem 1rem;
  background: var(--color-paper-raised);
  border-top: 1px solid var(--color-rule);
}
.chat-input-form {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}
.chat-textarea {
  flex: 1;
  min-height: 2.375rem;
  max-height: 8rem;
  resize: none;
  line-height: 1.5;
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
}
</style>
