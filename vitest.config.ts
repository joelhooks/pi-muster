import { defineConfig } from "vitest/config";

// Only Muster's own tests: mirrored sources under .agent_sources carry their own suites.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
