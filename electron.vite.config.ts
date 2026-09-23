import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // The Companion page also runs on phones and tablets: target the same
      // browsers as Tailwind v4 and Atmosphere rather than Electron's Chromium only.
      target: ['chrome111', 'edge111', 'safari16.4', 'firefox128'],
      cssTarget: ['chrome111', 'edge111', 'safari16.4', 'firefox128'],
      rollupOptions: {
        // The Companion page is served to other devices by the app's local web server.
        input: {
          index: resolve('src/renderer/index.html'),
          companion: resolve('src/renderer/companion.html')
        }
      }
    }
  }
})
