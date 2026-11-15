import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own SQLite database (see the setup file): parallel
    // files must never share or wipe each other's rows.
    setupFiles: ['./tests/setup-isolated-db.ts'],
    exclude: ['node_modules', 'dist', 'tests/integration'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
