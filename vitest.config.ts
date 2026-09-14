import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Guarantees no test can touch the real ~/.truss.
    setupFiles: ["src/test-setup.ts"],
  },
});
