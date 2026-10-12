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

  /* 只接管 GET：
     - Cache API 的 `put` 对非 GET 请求会直接 reject，而这里没 await（也没有
       waitUntil），抛出来就是 SW 里的未处理拒绝；
     - 「离线兜底」对写请求也毫无意义（会回一个 503 文本体）。
     /api/ 一律不缓存；/updates/ 是 APK（几十 MB），塞进 Cache Storage 只会白占配额。 */
  if (request.method !== 'GET') return
  if (request.url.includes('/api/')) return
  if (request.url.includes('/updates/')) return

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
