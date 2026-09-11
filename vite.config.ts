import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // voice synthesis runs in a module worker (voWorker.ts) with a dynamic
  // kokoro-js import — workers must use ESM output for code-splitting
  worker: { format: 'es' },
})
