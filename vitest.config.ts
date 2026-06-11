import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/middleware/**', 'src/routes/**', 'src/services/**'],
      exclude: ['src/**/*.test.ts'],
    },
  },
  resolve: {
    // Permet à Vitest de résoudre les imports .js → .ts (pattern ESM TypeScript)
    extensions: ['.ts', '.js'],
  },
})
