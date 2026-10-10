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
    <aside class="brand">
      <div class="brand-inner">
        <!-- 品牌符号 = 应用图标 = 一块仪表：面 + 刻度 + 指针 + 红区。
             登录页是第一次看到产品的地方，所以先看到产品自己的隐喻。 -->
        <svg class="brand-gauge" viewBox="0 0 120 72" aria-hidden="true">
          <path d="M12 60h96" stroke="var(--color-notch)" stroke-width="2" />
          <g stroke="var(--color-readout-3)" stroke-width="2">
            <path d="M12 60V48M31 60V52M50 60V52M69 60V52M88 60V52M108 60V48" />
          </g>
          <g stroke="var(--color-redline)" stroke-width="2" opacity="0.7">
            <path d="M88 60V52M108 60V48" />
          </g>
          <path d="M66 62V16" stroke="var(--color-readout)" stroke-width="4" />
          <path d="M61.5 6h9L66 15z" fill="var(--color-readout)" />
        </svg>
        <h1 class="brand-title">财务工作台</h1>
        <p class="brand-tagline">说一句话就记一笔账。<br />钱是读数，不是文档。</p>
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
  border-right: 1px solid var(--color-rule);
  background: var(--color-paper);
}
@media (max-width: 1023px) {
  .brand { border-right: 0; border-bottom: 1px solid var(--color-rule); }
}
.brand-inner {
  width: 100%;
  max-width: 22rem;
}
/* 品牌符号就是那块仪表：深色面板，恒定不随系统变。
   「钱是读数」这句话只有配一个真的刻度带才立得住。 */
.brand-gauge {
  display: block;
  width: 100%;
  max-width: 17rem;
  height: auto;
  margin-bottom: 1.25rem;
  padding: 1.125rem 1.25rem 0.875rem;
  background: var(--color-bezel);
  border: 1px solid color-mix(in srgb, var(--color-readout) 14%, transparent);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-bezel);
}
.brand-title {
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--color-ink-1);
}
.brand-tagline {
  margin-top: 0.5rem;
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
