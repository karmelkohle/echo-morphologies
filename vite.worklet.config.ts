import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The AudioWorklet is built separately from the app.
 *
 * `AudioContext.audioWorklet.addModule()` takes a URL, and the module it loads
 * runs in AudioWorkletGlobalScope — no DOM, no `window`, its own module graph.
 * Bundling it as a standalone ES module (rather than letting it fall out of the
 * app's chunk graph) keeps its filename stable and guarantees the whole DSP
 * engine is inlined into the one file the audio thread loads.
 *
 * Output lands in `public/worklet/` so that the dev server and `vite build`
 * both serve it from the same path. Run this before the app build.
 */
export default defineConfig({
  // The output lands inside `public/`, so copying `public/` into it would
  // recurse the whole static tree one level down.
  publicDir: false,
  build: {
    outDir: 'public/worklet',
    emptyOutDir: true,
    target: 'es2022',
    // Readable output: this code runs on the audio thread and is the first
    // place you look when something glitches on the device.
    minify: false,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/worklet/engine-processor.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'engine-processor.js',
    },
  },
})
