---
name: bnote-deploy
description: Build bnote (the Tauri app) and replace the running / installed /Applications/bnote.app. Use this when the user asks to "构建并替换" (build and replace), "打包部署" (package and deploy), "更新一下应用" (update the app), "构建启动" (build and launch), "发布一版试试" (ship a release), or anything else that involves building, packaging, deploying or replacing the running bnote instance; it also supports building without deploying. Whether a front-end change should be built is the user's decision — do not run this on your own (the user has explicitly said "只调试不构建" / debug only, do not build).
---

# Building and deploying bnote

Build the current code into a release bundle and replace the bnote running on
the system. The whole flow is wrapped in a script — run it, do not re-type the
commands by hand.

## Usage

```bash
# Full flow: type check → build → kill the running instances → replace /Applications/bnote.app → launch and verify
.agents/skills/bnote-deploy/scripts/deploy.sh

# Variants
.agents/skills/bnote-deploy/scripts/deploy.sh --skip-typecheck  # skip tsc (style/doc-only changes)
.agents/skills/bnote-deploy/scripts/deploy.sh --build-only      # build without deploying (produces app + dmg)
.agents/skills/bnote-deploy/scripts/deploy.sh --dry-run         # only print the steps that would run
```

What the script does:

1. `pnpm exec tsc --noEmit` (unless `--skip-typecheck`)
2. `pnpm tauri build --bundles app` (deployment only needs the .app; the full
   log goes to /tmp/bnote-build.log, and the tail is printed on failure)
3. **Kill every** running bnote instance and confirm the processes are really
   gone: AppleScript graceful quit (so autosave flushes) → SIGTERM if it does
   not exit → SIGKILL if that does not work either; if it still cannot be
   killed, abort and do not enter the replacement step
4. `rm -rf /Applications/bnote.app && ditto <new bundle> /Applications/bnote.app`
   (delete first, then ditto; ditto preserves metadata and the signature, so do
   not use cp -R), and confirm the executable is in place afterwards
5. `open` to launch, and report the pid once the new bundle's own process
   shows up

Building first and killing the instances afterwards is deliberate: a failed
build leaves the running instance untouched.

Where the time goes (why deploying takes longer than you expect): the cargo
release rebuild is the bulk of it (tauri embeds the front-end assets into the
binary, so front-end changes trigger it too — roughly 1–1.5 minutes
incremental); DMG packaging was removed from the deploy path (create-dmg goes
through a Finder AppleScript, takes about half a minute and fails
intermittently) — deployment does not need it, use `--build-only` when you do
want a DMG (it builds the full app + dmg).

**"Every instance" includes the local ones**: `/Applications/bnote.app`, the
locally built `bundle/macos/bnote.app`, the `target/debug/bnote` of
`pnpm tauri dev`, and a directly run `target/release/bnote`. Local instances
register no bundle id, so AppleScript cannot find them — only signals reach
them. They can run side by side with the /Applications copy, and if they are
not closed you end up with "the new bundle is in place, but the screen still
shows the old window".

Detect instances **only by executable path** (`ps -Ao pid=,comm=`), never with
`pgrep -f bnote`: the repository path itself contains "bnote", so matching on
the command line would also kill the editor's language server.

## Notes

- A build usually takes 1–3 minutes (cargo incremental); run the script with
  `run_in_background` so it does not time out.
- Deploying quits the bnote instance the user is working in (autosave included,
  so at most the last second of typing is lost). That is part of the flow and
  needs no extra confirmation; only a graceful quit that genuinely hangs
  reaches SIGKILL, and only then can unsaved edits be lost.
- Do not touch the old version inside the DMG mounted under `/Volumes/bnote`
  (read-only image, cannot be updated).
- If the Dock icon does not change after the replacement, that is the system
  icon cache — `killall Dock` or log out and back in to refresh it.
- When the user explicitly says "不用构建/只调试" (do not build / debug only),
  running this skill is forbidden — verify in the dev server instead.
