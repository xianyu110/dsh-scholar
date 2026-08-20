import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
