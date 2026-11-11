import { defineConfig } from "vitest/config";

// Only tests that intentionally exercise the disposable PostgreSQL service
// belong here. SQLite-backed seams, mocks and pure logic suites live under the
// default test config (or a dedicated SQLite config), never against PG by accident.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/api.test.ts", "tests/integration/improvement.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
