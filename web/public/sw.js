/// <reference lib="webworker" />

const CACHE_NAME = 'bill-v1'
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
]

// 安装：缓存静态资源
self.addEventListener('install', (event) => {
  const e = event as ExtendableEvent
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  )
})

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  const e = event as ExtendableEvent
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    )
  )
})

// 请求拦截：网络优先，失败走缓存
self.addEventListener('fetch', (event) => {
  const e = event as FetchEvent
  const request = e.request

  // API 请求不缓存
  if (request.url.includes('/api/')) return

  e.respondWith(
    fetch(request)
      .then((response) => {
        // 成功则更新缓存
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached || new Response('Offline', { status: 503 })))
  )
})

export {}
