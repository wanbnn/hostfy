import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// The React app lives in ./web and compiles into ./public (served by Express).
export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [react()],
  server: {
    // Encaminha as chamadas de API para o backend durante o `npm run dev:web`.
    proxy: {
      '/api': {target: process.env.API_TARGET || 'http://localhost:1591', changeOrigin: true},
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
})