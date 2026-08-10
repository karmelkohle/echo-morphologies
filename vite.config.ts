import { defineConfig, type PluginOption } from 'vite'

// GitHub Pages serves the app from /<repo>/, local dev from /.
// The CI workflow sets PAGES_BASE; everything else falls back to the root.
const base = process.env.PAGES_BASE ?? '/'

// `npm run dev:https` turns on a self-signed certificate so the app can be
// opened from a phone on the same network — getUserMedia() refuses to run on
// a plain-http origin that isn't localhost.
async function optionalHttps(): Promise<PluginOption[]> {
  if (process.env.HTTPS !== '1') return []
  try {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl')
    return [basicSsl()]
  } catch {
    console.warn('[vite] HTTPS=1 but @vitejs/plugin-basic-ssl is not installed — serving over http')
    return []
  }
}

export default defineConfig(async () => ({
  base,
  plugins: await optionalHttps(),
  server: {
    host: true, // listen on the LAN so a phone can reach the dev server
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}))
