<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Notice from '@/components/ui/Notice.vue'

const router = useRouter()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleLogin() {
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '请填写用户名和密码'
    return
  }

  loading.value = true
  try {
    await auth.login(username.value, password.value)
    router.push('/')
  } catch (e: any) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen lg:grid lg:grid-cols-[1fr_420px]">
    <!-- 品牌面：桌面左栏，手机顶部 -->
    <aside class="brand paper-ruled">
      <div class="brand-inner">
        <div class="brand-mark">¥</div>
        <h1 class="brand-title">账本</h1>
        <div class="brand-rule double-rule"></div>
        <p class="brand-tagline">说一句话就记一笔账。<br />AI 驱动的个人财务工作台。</p>
      </div>
    </aside>

    <!-- 表单面 -->
    <main class="form-face">
      <div class="form-wrap">
        <div class="mb-6">
          <h2 class="text-lg font-[650] text-ink-1">登录</h2>
          <p class="text-xs text-ink-3 mt-1">欢迎回来，继续记你的账。</p>
        </div>

        <Notice v-if="error" tone="danger" class="mb-4">{{ error }}</Notice>

        <form @submit.prevent="handleLogin" class="space-y-4">
          <div>
            <label class="field-label">用户名</label>
            <input
              v-model="username"
              type="text"
              autocomplete="username"
              class="field"
              placeholder="请输入用户名"
            />
          </div>

          <div>
            <label class="field-label">密码</label>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="field"
              placeholder="请输入密码"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="btn btn-primary btn-block btn-lg"
          >
            {{ loading ? '登录中…' : '登录' }}
          </button>
        </form>

        <p class="text-center text-xs text-ink-3 mt-6">
          还没有账号？
          <router-link to="/register" class="link ml-0.5">注册</router-link>
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  border-bottom: 1px solid var(--color-rule);
}
.brand-inner {
  width: 100%;
  max-width: 22rem;
  text-align: center;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3.25rem;
  height: 3.25rem;
  border-radius: var(--radius-md);
  background: var(--color-action);
  color: var(--color-action-fg);
  font-size: 1.75rem;
  font-weight: 600;
  margin-bottom: 1rem;
}
.brand-title {
  font-size: 1.5rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--color-ink-1);
}
.brand-rule {
  width: 3rem;
  margin: 1rem auto;
}
.brand-tagline {
  font-size: 0.8125rem;
  color: var(--color-ink-3);
  line-height: 1.7;
}
.form-face {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  background: var(--color-paper-raised);
}
.form-wrap {
  width: 100%;
  max-width: 20rem;
}
@media (min-width: 1024px) {
  .brand {
    border-bottom: 0;
    border-right: 1px solid var(--color-rule);
    padding: 3rem;
  }
  .brand-inner { text-align: left; }
  .brand-rule { margin-left: 0; }
  .brand-title { font-size: 2rem; }
}
</style>
