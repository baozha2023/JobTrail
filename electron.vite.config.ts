import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import fs from 'node:fs'

const privateBuild = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'private-build.config.json'), 'utf8'),
)
if (!/^[0-9a-f]{64}$/i.test(privateBuild.configEncryptionKey ?? ''))
  throw new Error('private-build.config.json requires a 32-byte hexadecimal configEncryptionKey')

export default defineConfig({
  main: {
    define: { __CONFIG_ENCRYPTION_KEY__: JSON.stringify(privateBuild.configEncryptionKey) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          desktop: path.resolve(__dirname, 'src/main/desktop.ts'),
          'mcp-node': path.resolve(__dirname, 'src/main/mcp-node.ts'),
          'agent-worker': path.resolve(__dirname, 'src/main/agent/worker-bootstrap.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [vue()],
  },
})
