import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served from https://marcusblabs.github.io/balancer-token-yields/
const REPO_BASE = '/balancer-token-yields/'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? REPO_BASE : '/',
  server: { port: 3000 },
}))
