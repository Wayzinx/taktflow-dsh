import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// @taktflow/* 直接用子模块源码，和 scripts/build.mjs 的 alias 一致。
const vendor = fileURLToPath(new URL('./vendor/taktflow/packages/', import.meta.url))
const alias = Object.fromEntries(readdirSync(vendor).map((name) => [`@taktflow/${name}`, `${vendor}${name}/src/index.ts`]))

export default defineConfig({
  resolve: { alias },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['**/node_modules/**', 'vendor/**'] },
})
