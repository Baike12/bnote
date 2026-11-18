# Deployed-only checks

A short list of behaviors no automated layer can reach on macOS: the embedded
E2E WebDriver drives the app's webview but not the window server, and browser
mode fakes the native side entirely. They are **not untestable** — they are
checked against the deployed app, one row at a time, before a release is
called done.

Evidence rule: fill the last column with a date and one line of what you saw
("2026-11-18: focus lock covered every space; Escape restored the editor").
An empty column on a release that touched that subsystem is a blocker, not a
formality — these are the exact areas the blind-test rounds found breakage
that 3,300+ green tests did not see.

| Behavior | Trigger | Expected | Last verified |
|---|---|---|---|
| Pomodoro focus lock takes over the screen | start a focus session | window sits above everything; timer visible; the event tap hard-locks input | — |
| Focus unlock restores the world | end the session / Escape | previous windows, level and cursor restored | — |
| IME context switch follows editor focus | click across markdown, code and zh text | the system IME matches the context; a switch deferred by a busy context lands once the context is ready (no stuck Latin/zh state) | — |
| Native pen cursor on stylus hover | hover drawing canvas with the pen | custom cursor bitmap tracks the pen without visible lag | — |
| PDF render + annotations in study mode | open a PDF, draw annotations | pages render, strokes persist across reopen | — |
| Child preview windows (study / creative) | open a preview, resize the main window | the preview window follows bounds and stays on top of nothing it shouldn't | — |
| Global shortcut → daily note | press the daily-note hotkey | the note is created/opened even when the app is not frontmost | — |
| Window bounds restore across relaunch | move the window, quit, relaunch | geometry reopens as stored (resolved through the same data-dir) | — |
| Invest divider double-click reset | double-click each divider | widths return to 280/680 defaults (the drag gesture itself is locked by the E2E spec; the embedded WebKitWebDriver never synthesizes `dblclick`, so this stays a real-gesture check) | — |

Maintenance: add a row when a fix lands in native-only territory (window
levels, event taps, IME/TIS, webview chrome); say in the PR which row it
belongs to.
