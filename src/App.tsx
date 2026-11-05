import { useEffect, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { agentApi, api } from "@/lib/tauri";
import "./commands/builtin";
import { runCommand } from "@/commands/registry";
import { installGlobalKeybindings, setKeyModalOpen } from "@/commands/globalKeys";
import { loadKeymap, reloadKeymap } from "@/commands/keybindingOverrides";
import { installEditingChords } from "@/lib/editingChords";
import { registerVimExCommands } from "@/editor/vim/vim";
import { reloadDocument } from "@/editor/setup";
import { renumberHeadings } from "@/editor/numbering";
import { editorApi, findEditorFor } from "@/editor/api";
import { refreshProjects } from "@/projects/store";
import { PROJECTS_DIR } from "@/projects/model";
import { loadedFile } from "@/editor/loadedFile";
import { flushCursorSave, hasPendingCursorSave } from "@/editor/cursorMemory";
import { flushLinksPersist, hasPendingLinksPersist } from "@/daily/links";
import {
  flushFootprintsPersist,
  hasPendingFootprintsPersist,
  noteDirtyPaths,
} from "@/footprint/store";
import { flushPersistConfig, hasPendingPersist } from "@/state/appStore";
import { quitApp } from "@/app/quit";
import { trackWindowState } from "@/lib/windowState";
import { useFocusStore } from "@/focus/store";
import { imeOnWindowBlur, imeOnWindowFocus, imeWarmUp } from "@/editor/imeSwitch";
import {
  applySettingsToEditor,
  openVault,
  refreshTree,
  reloadSnippetsFromVault,
  restoreEditorFocus,
} from "@/app/actions";
import {
  DEFAULT_SETTINGS,
  setConfigSnapshot,
  useAppStore,
  type PersistedConfig,
} from "@/state/appStore";
import { Sidebar } from "@/components/Sidebar";
import { EditorPane } from "@/components/EditorPane";
import { JsonFilePane } from "@/components/JsonFilePane";
import { StudyLayout } from "@/components/StudyLayout";
import { CodeLayout } from "@/components/CodeLayout";
import { ProjectsLayout } from "@/components/ProjectsLayout";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { LinkSuggest } from "@/components/LinkSuggest";
import { CommandPalette } from "@/components/CommandPalette";
import { installCodeEvents } from "@/code/events";
import { QuickAddModal } from "@/components/QuickAddModal";
import { QuickTodoModal } from "@/components/QuickTodoModal";
import { SettingsModal } from "@/components/SettingsModal";
import { Toast, Welcome } from "@/components/Welcome";
import { fileName, isJsonPath } from "@/lib/path";
import { normalizeStudyHistory } from "@/study/history";
import {
  normalizeAgentWidth,
  normalizeContentWidth,
  studySplitToContentWidth,
} from "@/study/layoutModel";
import { normalizePageStep } from "@/study/reading";
import { normalizeWebZoom } from "@/study/webZoom";
import { normalizeAgentFont } from "@/study/agentFont";
import { normalizeDailyWidth, normalizeSideWidth } from "@/projects/layoutModel";
import { normalizeTreeWidth } from "@/code/treeWidth";
import { normalizeTermHeight } from "@/code/term/tabs";
import { normalizeTypewriterPosition } from "@/editor/typewriterPosition";

/** The canvas is a separate chunk (excalidraw plus its font loading); it is
 *  only downloaded when it is opened. */
const DrawingCanvas = lazy(() => import("@/components/DrawingCanvas"));

export default function App() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const currentFile = useAppStore((s) => s.currentFile);
  const mode = useAppStore((s) => s.mode);
  const drawingSession = useAppStore((s) => s.drawingSession);
  // Agent context: the backend reads the current note path for its system prompt.
  useEffect(() => {
    void agentApi.setCurrentNote(currentFile).catch(() => {});
  }, [currentFile]);

  useEffect(() => {
    installGlobalKeybindings();
    installEditingChords();
    registerVimExCommands((id) => runCommand(id));
    let unlisten: (() => void) | undefined;
    let imeUnlisten: (() => void) | undefined;
    let unlistenWindow: (() => void) | undefined;

    void (async () => {
      const cfg = (await api.loadAppConfig().catch(() => null)) as PersistedConfig | null;
      // Keybindings live with the vault: when there is a last vault, wait for
      // openVault to open it and then read `<vault>/.bnote/keybindings.json`;
      // without a vault yet, fall back to the legacy app config.
      if (!cfg?.lastVault) await loadKeymap(null).catch(() => {});
      // Window geometry is restored on the Rust side before the first frame (see
      // config.rs); here we only persist later moves and resizes, writing
      // through the same config snapshot.
      unlistenWindow = trackWindowState();
      // One-time migration: the legacy "last file" is a single global value, so it
      // necessarily belongs to the vault that was open last; move it into the
      // per-vault map under lastVault. Idempotent: if the write fails it is
      // simply recomputed on the next startup.
      if (cfg?.lastFile && cfg?.lastVault && !cfg.lastFileByVault?.[cfg.lastVault]) {
        cfg.lastFileByVault = { ...(cfg.lastFileByVault ?? {}), [cfg.lastVault]: cfg.lastFile };
      }
      setConfigSnapshot(cfg ?? {});
      if (cfg?.recentFiles?.length) {
        useAppStore.setState({ recentFiles: cfg.recentFiles });
      }
      // A legacy config without studyHistory means an empty history, not an error.
      useAppStore.setState({ studyHistory: normalizeStudyHistory(cfg?.studyHistory) });
      const saved = cfg?.settings ?? {};
      const settings = {
        ...DEFAULT_SETTINGS,
        ...saved,
        ime: { ...DEFAULT_SETTINGS.ime, ...(saved.ime ?? {}) },
        latex: { ...DEFAULT_SETTINGS.latex, ...(saved.latex ?? {}) },
        studyTranslate: {
          ...DEFAULT_SETTINGS.studyTranslate,
          ...(saved.studyTranslate ?? {}),
        },
        daily: { ...DEFAULT_SETTINGS.daily, ...(saved.daily ?? {}) },
      };
      // The legacy version stored the three column widths as studySplit:[agent,
      // content] (earlier still as ratios); migrate them to single pixel widths
      // for the assistant column and the content column, write them once, and
      // from then on no window resize changes those two widths.
      const legacySplit = studySplitToContentWidth(
        (saved as Record<string, unknown>).studySplit,
      );
      settings.studyContentWidth = normalizeContentWidth(
        legacySplit ?? settings.studyContentWidth,
        window.innerWidth,
      );
      settings.studyAgentWidth = normalizeAgentWidth(
        settings.studyAgentWidth,
        window.innerWidth,
      );
      // Code mode has its own two column widths; a legacy config has neither
      // key, so the defaults apply and broken values fall back the same way.
      settings.codeContentWidth = normalizeContentWidth(
        settings.codeContentWidth,
        window.innerWidth,
      );
      settings.codeAgentWidth = normalizeAgentWidth(
        settings.codeAgentWidth,
        window.innerWidth,
      );
      // Same for the two column widths of the projects view: a legacy config has
      // neither of them, so the defaults apply and hand-edited broken values
      // fall back to the defaults.
      settings.projectsSideWidth = normalizeSideWidth(settings.projectsSideWidth);
      settings.projectsDailyWidth = normalizeDailyWidth(settings.projectsDailyWidth);
      // Code project file tree width: a legacy config has no such key, so 190px
      // applies and a broken value falls back to the default.
      settings.codeTreeWidth = normalizeTreeWidth(settings.codeTreeWidth);
      // The terminal drawer height: same discipline as the tree width.
      settings.codeTermHeight = normalizeTermHeight(settings.codeTermHeight);
      // These legacy keys are unused now; drop them so they do not linger in the
      // config file. The right column tab model was replaced by the three column
      // layout (the assistant column is pinned left), so this key can only be
      // a leftover of an old config.
      delete (settings as Record<string, unknown>).studySplit;
      delete (settings as Record<string, unknown>).studyAgentOpen;
      delete (settings as Record<string, unknown>).studyRightTab;
      // A legacy config has no studyPageStep, so it defaults to 50%; a hand-edited
      // broken value is clamped back into range here too.
      settings.studyPageStep = normalizePageStep(settings.studyPageStep);
      // Same for the typewriter position: a legacy config has no such key, so 50%
      // (vertically centered) applies and out-of-range values are clamped back
      // to 20%-80%.
      settings.typewriterPosition = normalizeTypewriterPosition(
        settings.typewriterPosition,
      );
      // Same for the web zoom: a legacy config has no such key, so 100% applies and
      // hand-edited out-of-range values are clamped back to 50%-300%.
      settings.studyWebZoom = normalizeWebZoom(settings.studyWebZoom);
      // Same for the agent conversation font scale: without that key it is 100%, and
      // a broken value is clamped back to 85%-160%.
      settings.agentFontScale = normalizeAgentFont(settings.agentFontScale);
      useAppStore.getState().replaceSettings(settings);
      // Pomodoro: restore the previous timer state (endsAt is an absolute time, so
      // it is still judged as overtime after a restart).
      // While a focus session is running, restore brings back the exclusive
      // screen and the hard lock together - quitting the app does not end that
      // session; after restoring, re-sync the native state once more (a lock
      // left behind by a crash is released here).
      await useFocusStore.getState().restore(cfg?.focusTimer);
      await useFocusStore.getState().refreshStatus();
      unlisten = await listen<string[]>("vault-changed", (event) => {
        void handleVaultChanged(event.payload);
      });
      void listen<string>("ime-fallback", (event) => {
        useAppStore.getState().showToast(event.payload);
      }).then((off) => {
        imeUnlisten = off;
      });
      // TIS warmup (see imeWarmUp): the first TIS call has to reach out to the input
      // method service (~90ms measured on this machine) and must run on the
      // Apple main thread, so the cost cannot be deferred to the moment the
      // user first switches to vim mode.
      imeWarmUp();
      if (cfg?.lastVault) {
        await openVault(cfg.lastVault);
      }
      // The remembered code project is reopened in the background: code mode
      // stays where it is (the app always starts on the note), but entering
      // code mode later finds the repository ready with its tabs' file tree.
      if (cfg?.codeProject?.path) {
        const project = cfg.codeProject;
        void import("@/code/commands").then((m) => m.restoreCodeProject(project.path));
      }
    })();

    return () => {
      unlisten?.();
      imeUnlisten?.();
      unlistenWindow?.();
    };
  }, []);

  // Settings changes propagate to the editor (vim, typewriter, live preview…).
  useEffect(() => {
    const unsub = useAppStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) void applySettingsToEditor();
      // Heading auto-numbering was just enabled: renumber the current file once
      // right away so the feedback is immediate.
      if (s.settings.autoNumberHeadings && !prev.settings.autoNumberHeadings) {
        if (editorApi.view) renumberHeadings(editorApi.view);
      }
      // A modal (settings / switcher / palette / quick add) handing control
      // back: put the caret focus on the note again. Deferred past the modal
      // unmount, and skipped when something else already took focus (e.g.
      // openNote focusing the freshly loaded note).
      if (s.modal === null && prev.modal !== null) {
        setTimeout(restoreEditorFocus, 0);
      }
      // While a modal is open the focus is in the overlay, which belongs to none of
      // the three regions: the region keybindings yield, only the global
      // commands remain.
      if (s.modal !== prev.modal) setKeyModalOpen(s.modal !== null);
    });
    return unsub;
  }, []);

  // Quit-safety: the cursor save (300ms) and config write (300ms) are both
  // debounced — flush them when the app is hidden/closed, or the last cursor
  // move before a Cmd-Q would be lost and "remember position" breaks.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      flushCursorSave();
      flushPersistConfig();
      flushLinksPersist();
      flushFootprintsPersist();
    };
    document.addEventListener("visibilitychange", onHidden);
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (
            !hasPendingCursorSave() &&
            !hasPendingPersist() &&
            !hasPendingLinksPersist() &&
            !hasPendingFootprintsPersist()
          ) {
            return;
          }
          event.preventDefault();
          flushCursorSave();
          flushPersistConfig();
          flushLinksPersist();
          flushFootprintsPersist();
          await getCurrentWindow().destroy();
        })
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // not running under Tauri
    }
    // Menu → Quit carries no key equivalent (⌘Q is deliberately unbound in
    // bnote's keybinding layer — an accidental quit must not happen; the
    // app.quit command exists for keybindings.json), so the native terminate
    // path is gone. The menu hands the request here instead, where the same
    // flush-then-destroy as the close button applies — quitting never costs
    // the debounced cursor/config write.
    // Language server events (diagnostics / status / log): an app-level
    // subscription, independent of the panel lifecycle.
    let unlistenCodeEvents: (() => void) | undefined;
    void installCodeEvents().then((off) => {
      unlistenCodeEvents = off;
    });

    let unlistenMenuQuit: (() => void) | undefined;
    void listen("bnote:menu-quit", quitApp)
      .then((off) => {
        unlistenMenuQuit = off;
      })
      .catch(() => {
        // not running under Tauri
      });
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      unlisten?.();
      unlistenMenuQuit?.();
      unlistenCodeEvents?.();
    };
  }, []);

  // Window activation: focus belongs on the current line again, and the IME
  // scope (forced source restored on blur, re-applied on focus) kicks in.
  // DOM focus/blur plus Tauri's window events — handlers are idempotent, so
  // double delivery from either channel is harmless.
  useEffect(() => {
    const onBlur = () => {
      flushCursorSave();
      imeOnWindowBlur();
    };
    const onFocus = () => {
      imeOnWindowFocus();
      restoreEditorFocus();
      // The accessibility permission is granted by the user in **System
      // Settings**, and the app receives no notification of it - re-read it
      // once when the user comes back from System Settings, otherwise the UI
      // keeps showing the stale "no permission" state and the user thinks the
      // grant did not take effect (while it actually did).
      void useFocusStore.getState().refreshStatus();
      // Reconcile the timer when the window comes back: after the window was
      // throttled in the background or the machine slept, the pomodoro display
      // must be recomputed against the real clock instead of waiting to
      // "catch up on beats".
      useFocusStore.getState().syncNow();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    // Switching Spaces or minimizing and coming back does not always come with a
    // window focus change, but it always flips the visibility state.
    const onVisible = () => {
      if (document.visibilityState === "visible") useFocusStore.getState().syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    let unlisten: (() => void) | undefined;
    try {
      // getCurrentWindow() throws synchronously outside a Tauri environment (the
      // browser harness); there only the DOM focus/blur handlers work and the
      // window event subscription is skipped.
      void getCurrentWindow()
        .onFocusChanged(({ payload }) => (payload ? onFocus() : onBlur()))
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // not running under Tauri
    }
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unlisten?.();
    };
  }, []);

  const breadcrumb = (() => {
    if (!vaultPath) return "bnote";
    const rel = currentFile?.startsWith(vaultPath)
      ? currentFile.slice(vaultPath.length + 1)
      : "";
    const parts = [vaultName];
    if (rel) {
      const segs = rel.split("/");
      for (const seg of segs.slice(0, -1)) parts.push(seg);
      parts.push(fileName(rel).replace(/\.(md|markdown|txt)$/i, ""));
    }
    return parts.join("  /  ");
  })();

  const main = (
    <main className="main">
      {mode === "projects" ? (
        <ProjectsLayout />
      ) : mode === "code" ? (
        <CodeLayout />
      ) : mode === "study" ? (
        <StudyLayout />
      ) : (
        <>
          <div
            className="titlebar"
            data-tauri-drag-region
            // When the sidebar is hidden the macOS traffic lights overlay the
            // titlebar's left edge — keep the toggle button clear of them.
            style={{ paddingLeft: sidebarOpen ? 12 : 78 }}
          >
            <button
              className="icon-btn titlebar-icon"
              title={sidebarOpen ? "收起侧边栏 (⌘\\)" : "展开侧边栏 (⌘\\)"}
              onClick={() => useAppStore.getState().toggleSidebar()}
            >
              ◧
            </button>
            <div className="breadcrumb">{breadcrumb}</div>
          </div>
          {isJsonPath(currentFile) ? <JsonFilePane /> : <EditorPane />}
        </>
      )}
    </main>
  );

  return (
    <div className="app">
      {sidebarOpen && vaultPath && <Sidebar />}
      {main}
      {/* Code mode is independent of the vault: a repository can be worked on
          without a notebook open, so the welcome screen must not cover it. */}
      {!vaultPath && mode !== "code" && <Welcome />}
      <LinkSuggest />
      <QuickSwitcher />
      <CommandPalette />
      <QuickAddModal />
      <QuickTodoModal />
      <SettingsModal />
      {drawingSession && (
        <Suspense fallback={null}>
          <DrawingCanvas />
        </Suspense>
      )}
      <Toast />
    </div>
  );
}

async function handleVaultChanged(paths: string[]) {
  const store = useAppStore.getState();
  // An external change can only land on "the instance that holds currentFile":
  // in the projects view the active view may be a project card editor, and
  // comparing it against the note on disk would push the note into the project
  // document.
  const view = store.currentFile ? findEditorFor(store.currentFile) : null;

  // Today's footprint: file changes from any source are fed to the footprint
  // library first (it does its own filtering and debouncing). This must run
  // before the self-write echo early return below - "typing in the editor ->
  // autosave -> watcher" is the main data path for the footprint.
  noteDirtyPaths(paths);

  // The keybindings config is a plain file in the vault: an external editor
  // saves it and the watcher triggers a re-read here.
  if (paths.some((p) => p.replace(/\\/g, "/").endsWith("/.bnote/keybindings.json"))) {
    void reloadKeymap();
  }

  // Project files (created / deleted / renamed externally) only affect the left
  // sidebar list; the document content belongs to the card editor, so do not
  // touch the document being edited here - that would wipe unsaved input.
  if (paths.some((p) => p.replace(/\\/g, "/").includes(`/${PROJECTS_DIR}/`))) {
    const vaultRoot = useAppStore.getState().vaultPath;
    if (vaultRoot) void refreshProjects(vaultRoot);
  }

  // Self-write echo: autosave/manual save triggers the watcher. When the only
  // change is the open note and disk matches memory, do nothing — reloading
  // would reset the cursor and drop the vim/snippet compartments.
  if (
    store.currentFile &&
    !store.dirty &&
    view &&
    paths.length === 1 &&
    paths[0] === store.currentFile
  ) {
    try {
      const disk = await api.readFile(store.currentFile);
      if (disk === view.state.doc.toString()) return;
    } catch {
      // deleted or unreadable — fall through to the generic path
    }
  }

  await refreshTree();
  const snippetOutcome = await reloadSnippetsFromVault();

  if (store.currentFile && paths.includes(store.currentFile)) {
    if (!store.dirty && view) {
      try {
        const content = await api.readFile(store.currentFile);
        if (content !== view.state.doc.toString()) {
          // Genuine external edit: reload keeping the cursor in place, then
          // re-apply settings — setState() resets the extension compartments.
          reloadDocument(view, content, store.currentFile);
          loadedFile.current = store.currentFile;
          await applySettingsToEditor(view);
        }
      } catch {
        // When the watcher events of the new and the old path of a just-opened file
        // interleave, the old, already renamed file may be read - close it only
        // while it is still the current file, so a freshly opened note is never
        // closed by mistake.
        if (useAppStore.getState().currentFile === store.currentFile) {
          store.closeFile();
        }
      }
    }
  }

  if (store.settings.vim && paths.some((p) => p.includes(".bnote/vimrc"))) {
    await applySettingsToEditor();
  }

  // The vault snippet file itself changed: surface the load result - report the
  // count on success, the reason on failure (the blob import was blocked by the
  // CSP, the user JS has a syntax error; these used to be swallowed silently,
  // so the change appeared to have no effect).
  if (snippetOutcome && paths.some((p) => p.includes(".bnote/snippets"))) {
    if (snippetOutcome.status === "user") {
      store.showToast(`公式片段已更新，共 ${snippetOutcome.count} 条`);
    } else if (snippetOutcome.status === "error") {
      store.showToast(`公式片段加载失败: ${snippetOutcome.error}`);
    }
  }
}
