/**
 * Service worker: offline shell for the app.
 *
 * Deliberately hand-written and small. A generated precache manifest would have
 * to be regenerated on every build to stay in step with Vite's hashed
 * filenames; runtime caching stays correct without a build step knowing
 * anything about it.
 *
 * Bump CACHE_VERSION to force every client onto a clean cache.
 */

const CACHE_VERSION = 'v1'
const CACHE_NAME = `echo-morphologies-${CACHE_VERSION}`

/** Resolved against the worker's own URL, so this works under any base path. */
const SHELL = ['./', './index.html', './manifest.webmanifest', './worklet/engine-processor.js']

/** Same-origin assets whose filenames are fixed rather than content-hashed. */
const UNVERSIONED = /\/(worklet\/[^/]+\.js|manifest\.webmanifest)$/

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // Individually, so one missing file cannot fail the whole install.
      await Promise.all(
        SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigations go to the network first so a fresh deploy is picked up on the
  // next launch, and fall back to the cached shell when there is no signal.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, { shellFallback: true }))
    return
  }

  // Everything Vite emits under assets/ carries a content hash, so its URL
  // changes whenever its contents do and the cache can never go stale. The
  // worklet does not — it has a fixed filename so the service worker and the
  // engine can both name it. Left on stale-while-revalidate it would pair a
  // freshly deployed interface with the previous build's DSP for one launch,
  // which is a version skew across the thread boundary and reads as a
  // parameter that silently does nothing. Cheap to avoid: it is 20 kB.
  if (UNVERSIONED.test(url.pathname)) {
    event.respondWith(networkFirst(request, { shellFallback: false }))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirst(request, { shellFallback }) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached
    // Only a navigation may be answered with the shell; handing index.html to a
    // script request would fail in a far more confusing way than a clean error.
    if (shellFallback) return (await cache.match('./index.html')) ?? Response.error()
    return Response.error()
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => undefined)

  if (cached) return cached
  return (await network) ?? Response.error()
}
