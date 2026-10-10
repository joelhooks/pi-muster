import { defineConfig } from "vitest/config";

// Only Muster's own tests: mirrored sources under .agent_sources carry their own suites.
// globalSetup scopes every fixture's tmpdir() to one run root and removes it afterwards.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], globalSetup: ["src/test-tmp.ts"] } });
