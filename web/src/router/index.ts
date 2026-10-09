import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/Login.vue'),
      meta: { guest: true, title: '登录' },
    },
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/Register.vue'),
      meta: { guest: true, title: '注册' },
    },
    {
      path: '/onboarding',
      name: 'Onboarding',
      component: () => import('@/views/Onboarding.vue'),
      meta: { auth: true, title: '初始设置' },
    },
    {
      // 落地页 = 记账。真实使用里 90%+ 的动作是「记一笔」，
      // 首屏应该直接面对输入框，而不是先看统计再去找入口。
      path: '/',
      name: 'QuickEntry',
      component: () => import('@/views/Home.vue'),
      meta: { auth: true, title: '记一笔' },
    },
    {
      path: '/quick',
      redirect: '/',
    },
    {
      path: '/overview',
      name: 'Dashboard',
      component: () => import('@/views/Dashboard.vue'),
      meta: { auth: true, title: '本月' },
    },
    {
      path: '/ledger',
      name: 'Ledger',
      component: () => import('@/views/Ledger.vue'),
      meta: { auth: true, title: '账本' },
    },
    {
      path: '/ai',
      name: 'AiChat',
      component: () => import('@/views/AiChat.vue'),
      meta: { auth: true, title: 'AI 助手', flush: true },
    },
    {
      path: '/import',
      name: 'Import',
      component: () => import('@/views/Import.vue'),
      meta: { auth: true, title: '导入账单' },
    },
    {
      path: '/assets',
      name: 'Assets',
      component: () => import('@/views/Assets.vue'),
      meta: { auth: true, title: '资产全景' },
    },
    {
      path: '/me',
      name: 'Me',
      component: () => import('@/views/Me.vue'),
      meta: { auth: true, title: '我的' },
    },
    {
      path: '/settings',
      name: 'Settings',
      component: () => import('@/views/Settings.vue'),
      meta: { auth: true, title: '设置' },
    },
    {
      path: '/trash',
      name: 'Trash',
      component: () => import('@/views/Trash.vue'),
      meta: { auth: true, title: '回收站' },
    },
    // 兼容旧 URL 重定向（下线的功能统一收到 /me，那里不再列出）
    { path: '/transactions', redirect: '/ledger' },
    { path: '/stats', redirect: '/ledger' },
    { path: '/analysis', redirect: '/ledger' },
    { path: '/dashboard', redirect: '/overview' },
    { path: '/quick', redirect: '/' },
    { path: '/budget', redirect: '/me' },
    { path: '/goals', redirect: '/me' },
    { path: '/subscriptions', redirect: '/me' },
    { path: '/memories', redirect: '/settings' },
    {
      path: '/admin',
      name: 'Admin',
      component: () => import('@/views/Admin.vue'),
      meta: { auth: true, title: '管理面板' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      redirect: '/',
    },
  ],
})

// 路由守卫
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore()
  const token = auth.token || localStorage.getItem('token')

  if (to.meta.auth && !token) {
    next('/login')
  } else if (to.meta.guest && token) {
    next('/')
  } else {
    next()
  }
})

export default router
