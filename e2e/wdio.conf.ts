import type { TauriCapabilities } from "@wdio/tauri-service";
import type { Options } from "@wdio/types";
import { APP_BINARY, DATA_DIR } from "./paths";
import { cleanupWorkspace, prepareWorkspace } from "./workspace";

/**
 * Native E2E: the real Tauri binary drives the real Rust backend and the real
 * WKWebView. Unit/integration tests fake the IPC boundary; this is the only
 * layer where file IO, the vault watcher, native shortcuts and the webview
 * boot order are the production ones.
 *
 * macOS uses the official embedded WebDriver (`driverProvider: "embedded"`),
 * which lives inside the app only when it is built with the Cargo `e2e`
 * feature. `pnpm test:e2e:build` produces that binary.
 *
 * Isolation: `--bnote-data-dir` points the whole app-data tree (config.json,
 * agent state, logs) at `e2e/.tmp/data`; the vault is a copy of
 * `e2e/fixtures/vault`. A run never reads or writes the user's real vault.
 */
export const config: Options.Testrunner & { capabilities: TauriCapabilities[] } = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: APP_BINARY },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: APP_BINARY,
        appArgs: [`--bnote-data-dir=${DATA_DIR}`],
        driverProvider: "embedded",
        // A cold WKWebView plus the embedded server can take a while on a
        // loaded CI machine; the test itself waits on DOM state, not on timers.
        startTimeout: 120_000,
        commandTimeout: 30_000,
        logLevel: "warn",
      },
    ],
  ],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  reporters: ["spec"],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  onPrepare: () => {
    prepareWorkspace();
  },
  onComplete: (exitCode) => {
    // A failing run keeps the vault, config and driver logs for inspection.
    if (exitCode === 0) cleanupWorkspace();
  },
};
