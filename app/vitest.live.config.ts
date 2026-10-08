import { defineConfig } from "vitest/config";

// Opt-in live-model teaching-quality evaluation. Consumes subscription allowance.
// Run only via `npm run eval:live`; never part of `npm test`.
export default defineConfig({
  test: { globals: true, include: ["test/live/**/*.test.ts"], environment: "node", testTimeout: 300000 },
});
