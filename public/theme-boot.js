// Startup theme bootstrap: set data-theme synchronously before React/CSS run,
// so light-theme users never see a dark flash.
// A separate file rather than an inline script: the Tauri CSP is
// script-src 'self' blob:, and inline scripts are silently blocked.
// The durable truth lives in config.json (settings.theme); this is only its
// startup mirror, written by applyTheme.
try {
  if (localStorage.getItem("bnote.theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  /* localStorage unavailable: render with the default dark theme */
}
