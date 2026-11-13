import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The test system has three Vitest projects, each with its own environment and
 * failure mode:
 *
 *   unit        — pure logic and module contracts (node, fast, always green)
 *   integration — several real modules wired through a fake Tauri IPC
 *                 boundary (jsdom, `src/test/setup.integration.ts`)
 *   perf        — order-of-magnitude gates, deliberately outside the coverage
 *                 run: V8 coverage instrumentation adds enough overhead to
 *                 push a 2.5ms median past its budget
 *
 * `pnpm test` runs unit + integration. `pnpm test:perf` is separate (CI
 * nightly / hot-path PRs) because a loaded machine can produce a false
 * failure; see docs/TESTING.md.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: [
            "src/**/*.integration.test.ts",
            "src/**/*.integration.test.tsx",
            "src/**/perf.gate.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "jsdom",
          include: ["src/**/*.integration.test.ts", "src/**/*.integration.test.tsx"],
          setupFiles: ["src/test/setup.integration.ts"],
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: "perf",
          environment: "node",
          include: ["src/**/perf.gate.test.ts"],
          testTimeout: 30000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.integration.test.{ts,tsx}",
        "src/**/perf.gate.test.ts",
        "src/**/*.d.ts",
        // React views are wiring: the project keeps behavior in plain modules
        // (AGENTS.md rule 4). Their flows are covered by E2E; component `.ts`
        // helpers (toolSummary, agentCards, …) stay in the measurement.
        "src/**/*.tsx",
        "src/dev/**",
        "src/test/**",
        "src/main.tsx",
      ],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // Filled from the measured baseline and ratcheted upward as the suite
      // grows. A threshold below the measured value is a ratchet, not a goal:
      // it fails when a change deletes tests or leaves a new module untested.
      thresholds: {
        lines: 65,
        statements: 63,
        functions: 61,
        branches: 59,
        // Domains with a pure, fully testable core carry a stricter ratchet.
        "src/daily/**": { lines: 80, statements: 76, functions: 70, branches: 71 },
        "src/focus/**": { lines: 95, statements: 92, functions: 96, branches: 85 },
        "src/projects/**": { lines: 62, statements: 57, functions: 58, branches: 54 },
        "src/agent/**": { lines: 98, statements: 95, functions: 98, branches: 90 },
        "src/vault/**": { lines: 98, statements: 98, functions: 98, branches: 98 },
        "src/templates/**": { lines: 98, statements: 98, functions: 98, branches: 76 },
        // Remaining domains, measured baseline minus a 2-point margin. They
        // are lower than the pure cores above, but any new untested module in
        // one of them still drops the domain below the ratchet.
        "src/app/**": { lines: 35, statements: 32, functions: 26, branches: 27 },
        "src/python/**": { lines: 75, statements: 72, functions: 77, branches: 63 },
        "src/state/**": { lines: 52, statements: 53, functions: 52, branches: 56 },
        "src/commands/**": { lines: 53, statements: 54, functions: 39, branches: 49 },
        "src/code/**": { lines: 55, statements: 53, functions: 42, branches: 58 },
        "src/study/**": { lines: 61, statements: 59, functions: 64, branches: 58 },
        "src/editor/**": { lines: 63, statements: 62, functions: 58, branches: 55 },
        "src/footprint/**": { lines: 68, statements: 66, functions: 57, branches: 60 },
        "src/components/**": { lines: 87, statements: 85, functions: 90, branches: 74 },
        "src/lib/**": { lines: 85, statements: 81, functions: 84, branches: 71 },
        "src/perf/**": { lines: 65, statements: 60, functions: 59, branches: 41 },
      },
    },
  },
});
