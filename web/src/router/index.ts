import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/Login.vue'),
      meta: { guest: true },
    },
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/Register.vue'),
      meta: { guest: true },
    },
    {
      path: '/onboarding',
      name: 'Onboarding',
      component: () => import('@/views/Onboarding.vue'),
      meta: { auth: true },
    },
    {
      path: '/import',
      name: 'Import',
      component: () => import('@/views/Import.vue'),
      meta: { auth: true },
    },
    {
      path: '/',
      name: 'Home',
      component: () => import('@/views/Home.vue'),
      meta: { auth: true },
    },
    {
      path: '/transactions',
      name: 'Transactions',
      component: () => import('@/views/Transactions.vue'),
      meta: { auth: true },
    },
    {
      path: '/stats',
      name: 'Stats',
      component: () => import('@/views/Stats.vue'),
      meta: { auth: true },
    },
    {
      path: '/ai',
      name: 'AiChat',
      component: () => import('@/views/AiChat.vue'),
      meta: { auth: true },
    },
    {
      path: '/budget',
      name: 'Budget',
      component: () => import('@/views/Budget.vue'),
      meta: { auth: true },
    },
    {
      path: '/settings',
      name: 'Settings',
      component: () => import('@/views/Settings.vue'),
      meta: { auth: true },
    },
    {
      path: '/trash',
      name: 'Trash',
      component: () => import('@/views/Trash.vue'),
      meta: { auth: true },
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
  const token = localStorage.getItem('token')

  if (to.meta.auth && !token) {
    next('/login')
  } else if (to.meta.guest && token) {
    next('/')
  } else {
    next()
  }
})

export default router
