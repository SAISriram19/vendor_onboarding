import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    proxy: {
      // proxy API to FastAPI so the frontend can use same-origin /api in dev
      '/api': 'http://localhost:8077',
    },
  },
})
