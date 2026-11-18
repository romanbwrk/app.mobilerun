import { defineConfig } from "vitest/config"

import base from "./vitest.config"

/**
 * Smoke tests against a real mcpocket. Opt-in: they skip unless
 * MCPOCKET_LIVE_KEY (an operator-role key) is set. Run with `npm run test:live`.
 */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["tests/live/**/*.smoke.ts"] },
})
