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
        lines: 87,
        statements: 85,
        functions: 86,
        branches: 80,
        // Domains with a pure, fully testable core carry a stricter ratchet.
        "src/agent/**": { lines: 98, statements: 98, functions: 98, branches: 98 },
        "src/code/**": { lines: 97, statements: 96, functions: 94, branches: 92 },
        "src/components/**": { lines: 98, statements: 97, functions: 98, branches: 96 },
        "src/daily/**": { lines: 95, statements: 92, functions: 92, branches: 88 },
        "src/editor/**": { lines: 78, statements: 76, functions: 71, branches: 71 },
        "src/footprint/**": { lines: 94, statements: 91, functions: 91, branches: 83 },
        "src/focus/**": { lines: 95, statements: 92, functions: 96, branches: 85 },
        "src/lib/**": { lines: 97, statements: 96, functions: 95, branches: 87 },
        "src/perf/**": { lines: 94, statements: 91, functions: 95, branches: 81 },
        "src/projects/**": { lines: 97, statements: 95, functions: 94, branches: 90 },
        "src/python/**": { lines: 88, statements: 85, functions: 87, branches: 80 },
        "src/state/**": { lines: 96, statements: 94, functions: 93, branches: 90 },
        "src/study/**": { lines: 87, statements: 84, functions: 86, branches: 78 },
        "src/templates/**": { lines: 98, statements: 98, functions: 98, branches: 76 },
        "src/vault/**": { lines: 98, statements: 98, functions: 98, branches: 98 },
        // Remaining domains, measured baseline minus a 2-point margin. They
        // are lower than the pure cores above, but any new untested module in
        // one of them still drops the domain below the ratchet.
        "src/app/**": { lines: 77, statements: 75, functions: 74, branches: 69 },
        "src/commands/**": { lines: 82, statements: 81, functions: 77, branches: 79 },
      },
    },
  },
});
