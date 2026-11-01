import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { agentApi, type PreviewBounds, type StudyContent } from "@/lib/tauri";
import { bindingsForCommand, formatBinding, pageForwardKeys } from "@/commands/keys";
import { getKeymapRevision, subscribeKeymap } from "@/commands/keybindingOverrides";
import { resolveBoundCommand, runBoundKey } from "@/commands/globalKeys";
import { useAppStore } from "@/state/appStore";
import {
  pdfHistoryForVault,
  type StudyCodeEntry,
  type StudyPdfEntry,
  type StudyUrlEntry,
  type WereadBookEntry,
} from "@/study/history";
import { setWebNavHandlers } from "@/study/pdfNav";
import { needsMainWebviewFocus } from "@/study/previewFocus";
import { ensureMaterial } from "@/study/materials";
import { normalizePageStep } from "@/study/reading";
import { formatWebZoom, normalizeWebZoom, stepWebZoom } from "@/study/webZoom";
import {
  flushWebAnnotations,
  loadWebAnnotations,
  normalizeWebAnnotations,
  saveWebAnnotations,
  WEB_ANNOTATION_SCRIPT,
  type WebAnnotationKind,
} from "@/study/webAnnotations";
import {
  isWereadUrl,
  normalizeWereadRoute,
  wereadFallbackTitle,
  WEREAD_HOME_URL,
  WEREAD_SCRIPT,
  type WereadRoutePayload,
} from "@/study/weread";
import { ErrorBoundary } from "./ErrorBoundary";
import { CodeProjectPane } from "@/code/components/CodeProjectPane";
import { StudyHistoryMenu } from "./StudyHistoryMenu";

/**
 * Study-mode center column.
 *
 * PDFs are *not* converted: the file is copied into its material folder
 * (`<vault>/.bnote/materials/pdfs/<dir>/`) and shown by the pdf.js reader,
 * so what the user browses is the paper itself. Web
 * pages are still embedded as a native child webview glued to the placeholder
 * — see `agent.rs::show_study_preview` for why it is not an iframe.
 */

/**
 * Material directory for a web page / weread book: the title is the best of
 * "the book currently being read -> the title known from the history"
 * (the directory name is only used when the entry is registered the first
 * time, after that the backend registry fixes it).
 */
async function urlMaterialDir(vaultRoot: string, url: string): Promise<string | null> {
  const state = useAppStore.getState();
  const book = state.studyWereadBook;
  const title =
    book && book.url === url
      ? book.title
      : (state.studyHistory.weread.find((e) => e.url === url)?.title ?? "");
  const info = await ensureMaterial(vaultRoot, { kind: "url", url, title });
  return info?.relDir ?? null;
}

/** The paging bindings of the command layer; the in-page runtime matches these keys when the web page has the focus. */
function readPageKeyBindings() {
  return {
    prev: bindingsForCommand("study.pdf-prev-page"),
    next: bindingsForCommand("study.pdf-next-page"),
  };
}

/** The shortcut in a toolbar tooltip follows the current binding (after a rebinding in the settings the tooltip does not lie). */
function bindingLabel(id: string): string {
  const [first] = bindingsForCommand(id, "reading");
  return first ? formatBinding(first) : "未绑定";
}

/**
 * The init script = the annotation runtime + the step / paging keys /
 * forwarded keys that take effect on the first paint + the weread runtime
 * (it is reinstalled on every navigation; the weread runtime gates itself by
 * hostname at its start, so other sites pay nothing).
 */
function previewInitScript(step: number, translate: boolean): string {
  const keys = readPageKeyBindings();
  return [
    WEB_ANNOTATION_SCRIPT,
    `window.__bnoteAnno && window.__bnoteAnno.setStep(${normalizePageStep(step)});`,
    `window.__bnoteAnno && window.__bnoteAnno.setTranslate(${translate});`,
    `window.__bnoteReader && window.__bnoteReader.setKeys(${JSON.stringify(
      keys.prev,
    )}, ${JSON.stringify(keys.next)});`,
    `window.__bnoteReader && window.__bnoteReader.setHostKeys(${JSON.stringify(
      pageForwardKeys(),
    )});`,
    WEREAD_SCRIPT,
  ].join("\n");
}

/** pdf.js (+worker) is downloaded only when a PDF is really opened, so the app start is not slowed down. */
const PdfViewer = lazy(() =>
  import("./PdfViewer").then((m) => ({ default: m.PdfViewer })),
);

export function ContentPane() {
  const content = useAppStore((s) => s.studyContent);
  const setStudyContent = useAppStore((s) => s.setStudyContent);
  const studyHistory = useAppStore((s) => s.studyHistory);
  const recordStudyPdf = useAppStore((s) => s.recordStudyPdf);
  const recordStudyUrl = useAppStore((s) => s.recordStudyUrl);
  const recordStudyCode = useAppStore((s) => s.recordStudyCode);
  const recordWereadBook = useAppStore((s) => s.recordWereadBook);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const showToast = useAppStore((s) => s.showToast);
  const modal = useAppStore((s) => s.modal);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  // When the keybinding override table changes, the new forwarded keys have to be pushed to the in-page runtime.
  const keymapRev = useSyncExternalStore(subscribeKeymap, getKeymapRevision, getKeymapRevision);
  const previewRef = useRef<HTMLDivElement>(null);
  /** The re-measure entry point while mounted; null when there is no native preview. */
  const previewSyncRef = useRef<(() => void) | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The web annotation tool: highlight / text annotation; null = plain reading. */
  const [webTool, setWebTool] = useState<WebAnnotationKind | null>(null);
  const webToolRef = useRef<WebAnnotationKind | null>(null);
  /**
   * The weread route the webview is actually on. Opening a book from the
   * shelf only changes the SPA route inside the webview, content.url stays
   * the shelf, and the book title in the top bar as well as the history
   * follow this route.
   */
  const [activeWeread, setActiveWeread] = useState<WereadRoutePayload | null>(null);
  const previewUrl = content?.kind === "url" ? content.url : null;
  const pdfs = pdfHistoryForVault(studyHistory, vaultPath);

  // When the content changes, "the book the webview is on" is void; until
  // the next route event arrives the top bar falls back to the title of the
  // content itself.
  useEffect(() => {
    setActiveWeread(null);
    useAppStore.getState().setStudyWereadBook(null);
  }, [content]);

  // The web page embedded in the middle column: report the rectangle of the
  // placeholder element to the backend and keep it in sync when it changes.
  // Size changes are caught by a ResizeObserver (dragging the content
  // divider, the window narrowing until the middle column shrinks, the
  // bookmarks bar toggling; in Tauri a native child webview is mounted and
  // has to move along with the layout). A change that only moves without
  // resizing is not seen by the ResizeObserver (dragging the agent
  // divider): that path is covered by StudyLayout dispatching
  // `bnote:study-layout-resize` during the drag, and it is reported here on
  // the way.
  // It depends on the whole content and not on previewUrl: typing the same
  // URL again means "reload", and it is exactly the new object that makes
  // this effect run again (the previous round closes the preview first).
  useEffect(() => {
    const el = previewRef.current;
    if (content?.kind !== "url" || !el) return;
    const url = content.url;
    let closed = false;
    let lastKey = "";
    const sync = (create: boolean) => {
      const bounds = previewBounds(el);
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      const call = create
        ? agentApi.showStudyPreview(
            url,
            bounds,
            previewInitScript(
              useAppStore.getState().settings.studyPageStep,
              useAppStore.getState().settings.studyTranslate.enabled,
            ),
          )
        : agentApi.setStudyPreviewBounds(bounds);
      void call.then(
        () => {
          if (create && !closed) setPreviewError(null);
          // A newly created webview starts at 100%: push the value from the
          // settings once more (the zoom of an existing webview is not
          // reset by a navigation, and pushing it again is idempotent).
          if (create && !closed) {
            void agentApi
              .setStudyPreviewZoom(
                normalizeWebZoom(useAppStore.getState().settings.studyWebZoom),
              )
              .catch(() => {});
          }
        },
        (e: unknown) => {
          if (create && !closed) {
            setPreviewError(String(e).replace(/^[A-Z_]+:\s*/, ""));
          }
        },
      );
    };
    sync(true);
    previewSyncRef.current = () => sync(false);
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(el);
    const onLayoutResize = () => sync(false);
    window.addEventListener("bnote:study-layout-resize", onLayoutResize);
    return () => {
      closed = true;
      previewSyncRef.current = null;
      observer.disconnect();
      window.removeEventListener("bnote:study-layout-resize", onLayoutResize);
      void agentApi.closeStudyPreview().catch(() => {});
    };
  }, [content]);

  // Toggling the sidebar only translates the middle column, its size is
  // unchanged and the ResizeObserver does not see it, so the coordinates are
  // reported once after the layout is committed, otherwise the native
  // webview stays at the old position. (The same holds for the three column
  // widths: the left edge of the content column follows the agent column
  // width.)
  useLayoutEffect(() => {
    previewSyncRef.current?.();
  }, [sidebarOpen, settings.studyAgentWidth]);

  // The native view always paints above the DOM, so it has to be hidden while
  // an HTML overlay like the settings or the palette is open, and shown again
  // when it closes. The canvas is the same: a fullscreen overlay that must
  // not be covered by the native view while it is open.
  const canvasOpen = useAppStore((s) => s.drawingSession !== null);
  useEffect(() => {
    if (!previewUrl) return;
    // The history dropdown has to be hidden as well: it is a DOM overlay and
    // the native web view always paints above the DOM, so the lower half of
    // the dropdown would be covered by the page.
    void agentApi
      .setStudyPreviewVisible(modal === null && !canvasOpen && !historyOpen)
      .catch(() => {});
  }, [previewUrl, modal, canvasOpen, historyOpen]);

  // The step and the paging keys are pushed to the in-page runtime (both
  // the keyboard paging and the dimming of the upper half use it). While the
  // settings modal is open the native view is hidden, so they are pushed
  // again after it closed, including the just changed keybindings.
  // On the first creation a command may arrive before the webview is ready;
  // the load event pushes them once more.
  useEffect(() => {
    if (!previewUrl || modal !== null) return;
    const keys = readPageKeyBindings();
    void agentApi
      .setStudyPreviewReadStep(normalizePageStep(settings.studyPageStep))
      .catch(() => {});
    void agentApi.setStudyPreviewReadKeys(keys.prev, keys.next).catch(() => {});
  }, [previewUrl, settings.studyPageStep, modal]);

  // The forwarded keys follow the configuration: when the "reading area ->
  // Agent / notes area" key is changed in the settings, the in-page runtime
  // switches to the new key right away, without reloading the page.
  useEffect(() => {
    if (!previewUrl || modal !== null) return;
    void agentApi.setStudyPreviewShortcuts(pageForwardKeys()).catch(() => {});
  }, [previewUrl, modal, keymapRev]);

  // Web zoom: the settings are the only writer (the toolbar button and the
  // command only write the settings), here the value is pushed to the native
  // view. It is pushed once more when a webview is created and after every
  // navigation.
  const webZoom = normalizeWebZoom(settings.studyWebZoom);
  useEffect(() => {
    if (!previewUrl) return;
    void agentApi.setStudyPreviewZoom(webZoom).catch(() => {});
  }, [previewUrl, webZoom]);

  // Where the paging of the web reader lands: when the focus is in the main
  // window (after clicking the toolbar or taking a note), the command layer
  // forwards PageUp/PageDown to the native child webview through here; when
  // the focus is inside the page, the in-page runtime takes over (the keys of
  // a native child webview do not bubble up to the main window).
  useEffect(() => {
    if (content?.kind !== "url") return;
    setWebNavHandlers({
      canFlip: () => useAppStore.getState().modal === null,
      prev: () => {
        void agentApi.scrollStudyPreview(-1).catch(() => {});
      },
      next: () => {
        void agentApi.scrollStudyPreview(1).catch(() => {});
      },
    });
    return () => setWebNavHandlers(null);
  }, [content]);

  // Web annotations: the page runtime writes its changes into document.title,
  // Rust turns them into Tauri events and sends them back (no remote IPC).
  // Every time the page finished loading, the annotation mode is applied
  // again and the anchors from the vault are pushed back into the page; the
  // page merges them by id and does not overwrite the data it updated
  // itself.
  useEffect(() => {
    let cancelled = false;
    const offs: Array<() => void> = [];
    const subscribe = <T,>(name: string, handler: (payload: T) => void) => {
      void listen<T>(name, (event) => handler(event.payload))
        .then((off) => {
          if (cancelled) off();
          else offs.push(off);
        })
        .catch(() => {
          // Browser mode has no native web preview, so these events never arrive.
        });
    };

    subscribe<string>("study-preview-loaded", (url) => {
      if (useAppStore.getState().studyContent?.kind !== "url") return;
      void (async () => {
        await agentApi
          .setStudyPreviewTranslate(
            useAppStore.getState().settings.studyTranslate.enabled,
          )
          .catch(() => {});
        await agentApi.setStudyPreviewAnnotationMode(webToolRef.current);
        // Every navigation reinstalls the runtime in the page: the step (and
        // the upper half dimming of the page) has to be pushed again.
        // A failing step push (a navigation is in flight) must not abort the
        // annotation merge that follows.
        await agentApi
          .setStudyPreviewReadStep(
            normalizePageStep(useAppStore.getState().settings.studyPageStep),
          )
          .catch(() => {});
        const keys = readPageKeyBindings();
        await agentApi
          .setStudyPreviewReadKeys(keys.prev, keys.next)
          .catch(() => {});
        await agentApi.setStudyPreviewShortcuts(pageForwardKeys()).catch(() => {});
        // The zoom is pushed again after the navigation: the settings are the single source of truth, the page does not keep a ratio itself.
        await agentApi
          .setStudyPreviewZoom(
            normalizeWebZoom(useAppStore.getState().settings.studyWebZoom),
          )
          .catch(() => {});
        const vault = useAppStore.getState().vaultPath;
        if (!vault || typeof url !== "string" || !url) return;
        const dir = await urlMaterialDir(vault, url);
        const list = await loadWebAnnotations(vault, url, dir);
        if (list.length > 0) {
          await agentApi.mergeStudyPreviewAnnotations(url, list);
        }
      })().catch(() => {});
    });

    subscribe<{ url?: unknown; annotations?: unknown }>(
      "study-web-annotations",
      (payload) => {
        const vault = useAppStore.getState().vaultPath;
        if (!vault || !payload || typeof payload.url !== "string") return;
        const url = payload.url;
        const list = normalizeWebAnnotations(payload.annotations);
        // The material directory has to be resolved first (this may be the first write of this web page): a failed resolution falls back to the old path.
        void urlMaterialDir(vault, url).then((dir) => {
          saveWebAnnotations(vault, url, list, dir);
        });
      },
    );

    // The weread route: the in-page runtime writes "the book currently being
    // read" into the title channel (study/weread.ts) and Rust dispatches it
    // here by prefix. It is only handled when the current content really is
    // a weread site: a late event from before the content changed must not
    // be written into the history. The book title is the best of "title of
    // the event -> title already known from the history -> URL fallback"; the
    // first report with an empty title must not overwrite a known title.
    subscribe<unknown>("study-weread-route", (payload) => {
      const state = useAppStore.getState();
      const current = state.studyContent;
      if (!current || current.kind !== "url" || !isWereadUrl(current.url)) return;
      const route = normalizeWereadRoute(payload);
      if (!route) return;
      const known = state.studyHistory.weread.find((e) => e.url === route.url)?.title;
      const title = route.title || known || wereadFallbackTitle(route.url);
      state.recordWereadBook({ url: route.url, title });
      state.setStudyWereadBook({ url: route.url, title });
      setActiveWeread({ url: route.url, title });
    });

    subscribe<{ key?: unknown }>("study-preview-key", (payload) => {
      const key = typeof payload?.key === "string" ? payload.key : null;
      if (!key) return;
      const target = resolveBoundCommand(key, "reading");
      // The web zoom only changes a page attribute on the Rust side and
      // needs no focus in the main window. Stealing the focus would leave
      // the user unable to scroll after pressing ⌘= and unable to type into
      // an input field of the page, so such commands run in place.
      if (!needsMainWebviewFocus(target)) {
        if (target) runBoundKey(key, "reading");
        return;
      }
      // The key comes from the native child webview: first pull the keyboard
      // back into the main window webview (`Webview.setFocus` ->
      // makeFirstResponder on the main WKWebView), then run it in the reading
      // region; the target command hands the focus to the input field or the
      // editor itself.
      void getCurrentWebview()
        .setFocus()
        .then(() => runBoundKey(key, "reading"))
        .catch(() => runBoundKey(key, "reading"));
    });

    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, []);

  // Opening a web page: with the translation on the default is plain reading
  // (otherwise the selection is eaten by the annotations and the
  // translation is never usable); with the translation off the previous
  // default stays, which is the highlight annotation directly. Switching
  // the tool is still up to the main window.
  useEffect(() => {
    if (content?.kind === "url") {
      const initial = useAppStore.getState().settings.studyTranslate.enabled
        ? null
        : "highlight";
      webToolRef.current = initial;
      setWebTool(initial);
      void agentApi.setStudyPreviewAnnotationMode(initial).catch(() => {});
      return;
    }
    webToolRef.current = null;
    setWebTool(null);
  }, [content]);

  // When the translation switch changes, the flag is pushed to the in-page
  // runtime; when it is turned on the current annotation tool is left, so
  // the translation is immediately usable. When it is turned off the current
  // tool is kept and not forced back to the highlight.
  const translateEnabled = settings.studyTranslate.enabled;
  useEffect(() => {
    if (!previewUrl) return;
    void agentApi.setStudyPreviewTranslate(translateEnabled).catch(() => {});
    if (translateEnabled && webToolRef.current !== null) {
      webToolRef.current = null;
      setWebTool(null);
      void agentApi.setStudyPreviewAnnotationMode(null).catch(() => {});
    }
  }, [previewUrl, translateEnabled]);

  // Before leaving the page the debounced write of the annotation file is flushed (the page still has localStorage as a fallback).
  useEffect(() => {
    const flush = () => flushWebAnnotations();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flushWebAnnotations();
    };
  }, []);

  // Drag & drop: PDFs are imported into the vault and shown as PDFs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void handleDrop(event.payload.paths);
          }
        })
        .then((off) => {
          unlisten = off;
        });
    } catch {
      // browser harness: no Tauri webview events
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDrop(paths: string[]) {
    const pdf = paths.find((p) => /\.pdf$/i.test(p));
    if (pdf) {
      await importAndOpen(pdf);
    } else {
      showToast("请拖入 PDF 文件");
    }
  }

  function openPdf(entry: { path: string; relPath: string; title: string }) {
    setStudyContent({ kind: "pdf", path: entry.path, title: entry.title });
    recordStudyPdf(entry);
  }

  async function importAndOpen(pdfPath: string) {
    setImporting(true);
    try {
      // The original file goes into its own material directory (next to the annotations and the sessions).
      const result = await agentApi.importPdf(pdfPath);
      openPdf({ path: result.pdfPath, relPath: result.relPath, title: result.title });
      showToast(`已收进 vault/${result.relPath}`);
    } catch (e) {
      showToast(`导入 PDF 失败: ${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    } finally {
      setImporting(false);
    }
  }

  /**
   * Opens (or re-navigates) the standalone preview window through the backend,
   * so a failure is a real error instead of the silent `tauri://error` event
   * the JS `new WebviewWindow(...)` API emits.
   */
  async function openPreview(url: string): Promise<boolean> {
    try {
      await agentApi.openStudyUrl(url);
      return true;
    } catch (e) {
      showToast(`打开网页失败: ${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
      return false;
    }
  }

  function openUrl(raw?: string) {
    const url = normalizeUrl(raw ?? urlInput);
    if (!url) {
      showToast("请输入网址");
      return;
    }
    setUrlInput("");
    // When the content changes, the effect above switches the web preview of
    // the middle column to this address (typing the same URL again reloads
    // it, because the content is a new object).
    // A weread URL does not enter the "web page" history: the reading record
    // comes from the in-page route event, which is where the book title is
    // known; here only the domain would be recorded, which carries no
    // information.
    const title = isWereadUrl(url)
      ? "微信读书"
      : url.replace(/^https?:\/\//, "").split("/")[0] || url;
    setStudyContent({ kind: "url", url, title });
    if (!isWereadUrl(url)) recordStudyUrl({ url, title });
  }

  /** Switching the web annotation tool: the state lives in the main window, the page only executes it (single writer). */
  function toggleWebTool(tool: WebAnnotationKind) {
    const next = webToolRef.current === tool ? null : tool;
    webToolRef.current = next;
    setWebTool(next);
    void agentApi.setStudyPreviewAnnotationMode(next).catch(() => {});
  }

  function openHistoryPdf(entry: StudyPdfEntry) {
    setHistoryOpen(false);
    openPdf(entry);
  }

  function openHistoryUrl(entry: StudyUrlEntry) {
    setHistoryOpen(false);
    setStudyContent({ kind: "url", url: entry.url, title: entry.title });
    // A weread URL belongs to the "weread" tab (there may be leftovers in an old configuration): it no longer enters the web page history.
    if (!isWereadUrl(entry.url)) recordStudyUrl({ url: entry.url, title: entry.title });
  }

  function openHistoryBook(entry: WereadBookEntry) {
    setHistoryOpen(false);
    setStudyContent({ kind: "url", url: entry.url, title: entry.title });
    // Reopening an old book has to move it to the top as well; the in-page
    // route event records it once more later, deduplicated by url.
    recordWereadBook({ url: entry.url, title: entry.title });
  }

  /** Reopens a code project from the history menu. */
  function openHistoryCode(entry: StudyCodeEntry) {
    setHistoryOpen(false);
    setStudyContent({ kind: "code", path: entry.path, title: entry.title });
    recordStudyCode({ path: entry.path, title: entry.title });
    // The project itself has to be opened for real (the file tree and the language server both depend on this step).
    void import("@/code/commands").then((m) => m.openProjectAt(entry.path));
  }

  /** The shelf, the store and the reading all live behind this one entry, completed by weread's own navigation. */
  function openWereadShelf() {
    setHistoryOpen(false);
    setStudyContent({ kind: "url", url: WEREAD_HOME_URL, title: "微信读书" });
  }

  async function pickPdf() {
    // A real filesystem path: the `<input type="file">` path is a sandbox
    // token in the webview, and the backend needs an actual path.
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: "选择 PDF 文件",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const path = typeof picked === "string" ? picked : null;
      if (path) await importAndOpen(path);
    } catch (e) {
      showToast(`选择文件失败: ${String(e)}`);
    }
  }

  /**
   * Opens a code project: native directory picker -> switch the middle
   * column to the code view.
   *
   * The command module is loaded on demand (the code module carries the
   * editor and must not slow down the first screen).
   */
  async function pickCodeProject() {
    try {
      const { openProjectDialog } = await import("@/code/commands");
      await openProjectDialog();
    } catch (e) {
      showToast(`打开代码项目失败: ${String(e)}`);
    }
  }

  return (
    <div
      className={`content-pane${dragging ? " dragging" : ""}`}
      data-key-region="reading"
      tabIndex={-1}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Study mode has no titlebar, so this row is the window drag region
          (buttons and input fields are unaffected).
          Three columns: left = clearance for the traffic lights; middle = the
          file name (which is the materials dropdown); right = the URL input
          and the PDF.
          The file name only occupies the middle column and the two outer
          columns have the same width, so it is truly centered in the whole
          bar. The left cell is empty for now (the agent column already sits
          at the far left); it stays empty only to keep the file name
          centered in the whole bar. */}
      <div className="content-toolbar" data-tauri-drag-region="deep">
        <div className="content-tool-left" />
        <StudyHistoryMenu
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          title={
            importing
              ? "正在导入 PDF…"
              : content
                ? activeWeread && content.kind === "url" && isWereadUrl(content.url)
                  ? activeWeread.title
                  : content.title
                : "学习模式"
          }
          initialTab={
            content?.kind === "url"
              ? isWereadUrl(content.url)
                ? "weread"
                : "url"
              : content?.kind === "code"
                ? "code"
                : "pdf"
          }
          pdfs={pdfs}
          urls={studyHistory.urls}
          books={studyHistory.weread}
          codes={studyHistory.codes}
          onOpenPdf={openHistoryPdf}
          onOpenUrl={openHistoryUrl}
          onOpenBook={openHistoryBook}
          onOpenCode={openHistoryCode}
          onOpenShelf={openWereadShelf}
          onImportPdf={() => {
            setHistoryOpen(false);
            void pickPdf();
          }}
          onOpenCodeProject={() => {
            setHistoryOpen(false);
            void pickCodeProject();
          }}
        />
        <div className="content-tool-right">
          <input
            className="content-url"
            type="text"
            placeholder="网址,回车打开…"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openUrl();
            }}
          />
          <button
            className="icon-btn pdf-tool-btn"
            title="选择 PDF 文件(存进材料目录)"
            onClick={() => void pickPdf()}
            disabled={importing}
          >
            ＋ PDF
          </button>
          <button
            className="icon-btn text-tool-btn"
            title="打开代码项目(选择文件夹)"
            onClick={() => void pickCodeProject()}
          >
            ＋ 代码
          </button>
          {content && (
            <button
              className="icon-btn"
              title="关闭当前内容"
              onClick={() => setStudyContent(null as StudyContent | null)}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="content-body">
        {!content && !importing && (
          <div className="content-empty">
            <p className="content-empty-title">拖入 PDF 直接阅读</p>
            <p className="content-empty-hint">
              PDF 会存进 <code>.bnote/materials/pdfs/</code>,与批注、会话放在一起。
            </p>
            <button className="btn content-pick" onClick={() => void pickPdf()}>
              选择 PDF 文件
            </button>
            <button className="btn btn-ghost content-pick" onClick={() => void pickCodeProject()}>
              打开代码项目…
            </button>
          </div>
        )}
        {content?.kind === "pdf" && (
          <ErrorBoundary
            resetKey={content.path}
            fallback={(error, reset) => (
              <div className="pdf-fail">
                <p className="content-empty-title">PDF 阅读器加载失败</p>
                <p className="pdf-status-msg">{error.message}</p>
                <button className="btn" onClick={reset}>
                  重试
                </button>
              </div>
            )}
          >
            <Suspense fallback={<div className="pdf-status">正在加载 PDF 阅读器…</div>}>
              <PdfViewer
                path={content.path}
                eyeCare={settings.studyEyeCare}
                onToggleEyeCare={() => patchSettings({ studyEyeCare: !settings.studyEyeCare })}
                pageStep={normalizePageStep(settings.studyPageStep)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {content?.kind === "url" && (
          <div className="content-web">
            <div className="content-web-bar">
              <span className="content-web-url" title={content.url}>
                {content.url}
              </span>
              {/* Page zoom: a native child webview has no zoom control of
                  its own, so here is a minimal -/readout/+ set; clicking the
                  readout returns to 100%. */}
              <div className="content-web-zoom" role="group" aria-label="网页缩放">
                <button
                  className="icon-btn content-web-zoom-btn"
                  title={`缩小网页(${bindingLabel("study.web-zoom-out")})`}
                  onClick={() =>
                    patchSettings({ studyWebZoom: stepWebZoom(webZoom, -1) })
                  }
                >
                  −
                </button>
                <button
                  className="content-web-zoom-value"
                  title={`当前 ${formatWebZoom(webZoom)},点击回到 100%(${bindingLabel(
                    "study.web-zoom-reset",
                  )})`}
                  onClick={() => patchSettings({ studyWebZoom: 1 })}
                >
                  {formatWebZoom(webZoom)}
                </button>
                <button
                  className="icon-btn content-web-zoom-btn"
                  title={`放大网页(${bindingLabel("study.web-zoom-in")})`}
                  onClick={() =>
                    patchSettings({ studyWebZoom: stepWebZoom(webZoom, 1) })
                  }
                >
                  +
                </button>
              </div>
              <button
                className={`icon-btn pdf-tool-btn${webTool === "highlight" ? " active" : ""}`}
                title={
                  webTool === "highlight"
                    ? "退出批注:网页恢复正常点击/选择"
                    : "高亮批注:在网页里拖选文字,标成亮黄色高亮;点已有高亮可取消"
                }
                onClick={() => toggleWebTool("highlight")}
              >
                ✎ 高亮
              </button>
              <button
                className={`icon-btn pdf-tool-btn${webTool === "note" ? " active" : ""}`}
                title={
                  webTool === "note"
                    ? "退出文字批注:网页恢复正常点击/选择"
                    : "文字批注:在网页里拖选文字,批注卡出现在选区旁;点已有批注卡继续编辑"
                }
                onClick={() => toggleWebTool("note")}
              >
                ✍ 文字
              </button>
              <button
                className="icon-btn"
                title="在独立窗口中打开(中栏里页面显示异常时用)"
                onClick={() => void openPreview(content.url)}
              >
                ↗
              </button>
            </div>
            {/* The native child webview covers this placeholder area, the scrolling and the clicks of the page belong to it. */}
            <div className="content-web-view" ref={previewRef}>
              {previewError && (
                <div className="content-web-fail">
                  <p className="content-empty-title">网页没能显示</p>
                  <p className="content-web-fail-msg">{previewError}</p>
                  <button
                    className="btn"
                    onClick={() => void openPreview(content.url)}
                  >
                    在独立窗口中打开
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {content?.kind === "code" && <CodeProjectPane />}
      </div>
    </div>
  );
}

/**
 * The rectangle of the placeholder element, converted into the logical pixel
 * coordinates the backend expects.
 *
 * The top left of the window content area is the origin of the DOM viewport
 * (the title bar is an overlay style and the content area fills the whole
 * window), so the viewport coordinates of `getBoundingClientRect()` can be
 * used as window coordinates directly.
 */
export function previewBounds(el: HTMLElement): PreviewBounds {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
