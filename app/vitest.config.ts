import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
    environment: "node",
    testTimeout: 20000,
    // Tests must never reach a real provider: force the deterministic mock.
    env: { LEARN_PROVIDER: "mock" },
  },
});
