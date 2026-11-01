import { useEffect, useRef } from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createEditor, loadDocument } from "@/editor/setup";
import { registerEditorView, unregisterEditorView } from "@/editor/api";
import { applySettingsToEditor } from "@/app/actions";

const AUTOSAVE_DELAY = 800;

export interface PaneEditorProps {
  /** The file currently loaded (null = empty document). */
  path: string | null;
  /** Reads the document when the file changes. */
  load: (path: string) => Promise<string>;
  /** Writes the document on autosave and on the flush before a switch. */
  save: (path: string, text: string) => Promise<void>;
  /** Notified on every document change (the project card uses it to update its in-memory cache). */
  onSnapshot?: (path: string, text: string) => void;
  /** Extra extensions fixed at instance creation (drag handles and the like). */
  extraExtensions?: Extension[];
  /** Whether typing a todo may auto-send it to today's daily note; the project card passes false. */
  allowAutoSend?: boolean;
  className?: string;
  /** Called when the instance is created and destroyed (the command layer focuses it directly). */
  onViewChange?: (view: EditorView | null) => void;
}

/**
 * An editor inside the project view (shared by the project cards and the
 * daily note in the right column).
 *
 * The difference to `EditorPane`: the whole file lifecycle is driven by props
 * (a changed path swaps the document), the autosave writes its own copy and
 * touches neither the global currentFile nor the global dirty flag. Before
 * switching files the unsaved content is flushed out, because the project
 * cards rotate by switching focus and missing one flush loses a keystroke.
 */
export function PaneEditor(props: PaneEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The most recent props: the effect that creates the editor runs only once, every other read goes through here. */
  const propsRef = useRef(props);
  propsRef.current = props;
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = createEditor(
      host,
      "",
      {
        onDocChanged: () => {
          const path = pathRef.current;
          if (!path) return;
          const text = view.state.doc.toString();
          propsRef.current.onSnapshot?.(path, text);
          dirtyRef.current = true;
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            flushRef.current();
          }, AUTOSAVE_DELAY);
        },
        onCursorMoved: () => {},
      },
      {
        allowAutoSend: propsRef.current.allowAutoSend,
        extraExtensions: propsRef.current.extraExtensions,
      },
    );
    viewRef.current = view;

    const flush = () => {
      const path = pathRef.current;
      if (!path || !dirtyRef.current) return;
      dirtyRef.current = false;
      propsRef.current.onSnapshot?.(path, view.state.doc.toString());
      void propsRef.current
        .save(path, view.state.doc.toString())
        .catch((e) => console.warn("pane save failed", e));
    };
    flushRef.current = flush;

    registerEditorView(view);
    propsRef.current.onViewChange?.(view);
    void applySettingsToEditor(view);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
      view.destroy();
      unregisterEditorView(view);
      viewRef.current = null;
      pathRef.current = null;
      propsRef.current.onViewChange?.(null);
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = props.path;
    if (pathRef.current === next) return;
    flushRef.current();
    pathRef.current = next;
    dirtyRef.current = false;
    if (!next) {
      loadDocument(view, "");
      return;
    }
    let cancelled = false;
    void props.load(next).then((text) => {
      // The target may have changed again while the read was in flight (rapid clicking through files): only the current path counts.
      if (cancelled || pathRef.current !== next) return;
      loadDocument(view, text, next);
    });
    return () => {
      cancelled = true;
    };
    // props.load is read through the ref, so only the path change is tracked here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  return <div className={props.className ?? "pane-editor"} ref={hostRef} />;
}
