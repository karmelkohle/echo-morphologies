/**
 * Registers the service worker that makes the app installable and lets it run
 * with no network — which is the point, given it is meant to be used outdoors.
 *
 * Skipped in development: a caching worker between Vite and the browser turns
 * every edit into a guessing game about which version is on screen.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (import.meta.env.DEV) return null
  if (!('serviceWorker' in navigator)) return null

  try {
    return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    })
  } catch {
    // Offline support is a bonus, not a requirement — the app runs regardless.
    return null
  }
}
