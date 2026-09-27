import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Public synthetic-test key. Never used by development or release builds.
  define: { __CONFIG_ENCRYPTION_KEY__: JSON.stringify('42'.repeat(32)) },
  plugins: [vue()],
  test: { include: ['tests/**/*.test.ts'] },
})
