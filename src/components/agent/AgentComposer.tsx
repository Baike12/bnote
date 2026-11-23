import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { copySelection, cutSelection, pasteClipboard } from "@/editor/ops";
import {
  commandMappingKeymap,
  currentVimMode,
  getCM,
  vimActiveLine,
  vimKeyCaptureExtension,
  vimModeExtension,
  vimVisualHighlight,
  Vim,
} from "@/editor/vim/vim";
import type { VimMapping, VimMode } from "@/editor/vim/vimrc";
import { ensureVimrcLoaded, onVimMappingsChanged, vimMappings } from "@/editor/vim/loader";
import { registerVimSurface } from "@/editor/vim/surfaces";
import { imeOnComposerFocus, imeSwitchExtension } from "@/editor/imeSwitch";
import { useAppStore } from "@/state/appStore";

/**
 * The agent prompt box: a real CodeMirror editor, so the notes area's vim
 * engine runs in it unchanged (mode switches, `imap jj <Esc>`, the shared
 * vimrc, the block cursor) instead of a second vim implementation over a
 * `<textarea>`.
 *
 * The text lives here (the editor document), not in React state: the panel
 * mirrors it for rendering (`canSend`, the completion trigger) and writes
 * through the controller it receives — one writer, no controlled-input loop
 * between two copies.
 *
 * Enter, the completion popup and the history walk are the panel's, not the
 * editor's; the panel routes those in the capture phase of the host, before
 * the vim engine (see `@/agent/composerKeys`).
 */

/** What the panel may do with the box; filled on mount, null after unmount. */
export interface ComposerController {
  focus(): void;
  text(): string;
  /** Replaces the whole text and places the caret (default: the end). */
  setText(text: string, caret?: number): void;
  selection(): { from: number; to: number };
  /** The vim mode, or null when vim is off. */
  mode(): VimMode | null;
  /** Enter vim insert mode: a programmatic edit (a shortcut that types for the
   *  user) must leave the box ready to continue typing. No-op with vim off. */
  enterInsert(): void;
  view(): EditorView | null;
}

export interface AgentComposerProps {
  /** Filled with the controller on mount (`controller.current`). */
  controller: RefObject<ComposerController | null>;
  /** Shared with the panel's key routing: an IME composition is in progress. */
  composing: RefObject<boolean>;
  placeholder: string;
  readOnly: boolean;
  /** Mirrors the document and the caret; `docChanged` separates typing from
   *  a mere caret move (the completion index resets only on a real change). */
  onChange: (text: string, caret: number, docChanged: boolean) => void;
  onBlur: () => void;
  /** The panel's own keys (send, the completion popup, the history walk),
   *  handled before the editor and the vim engine. */
  onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Image pastes are taken over by the panel; text pastes stay the editor's. */
  onPasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void;
}

export function AgentComposer({
  controller,
  composing,
  placeholder,
  readOnly,
  onChange,
  onBlur,
  onKeyDownCapture,
  onPasteCapture,
}: AgentComposerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vim = useAppStore((s) => s.settings.vim);
  const [mappings, setMappings] = useState<VimMapping[]>(vimMappings);

  // Latest props for the update listener, which is created once with the view.
  const handlers = useRef({ onChange });
  handlers.current = { onChange };

  // Compartments: one slot each for what changes after mount.
  const compartments = useRef({
    vim: new Compartment(),
    commandMap: new Compartment(),
    placeholder: new Compartment(),
    readOnly: new Compartment(),
    contentAttributes: new Compartment(),
  }).current;

  // The shared vimrc: the loader notifies after each load, so a note switch or
  // a vimrc edit reaches this box's command keymap as well.
  useEffect(() => onVimMappingsChanged(setMappings), []);

  // A panel can mount before any notes editor exists (a window with no note
  // open): `applySettingsToEditor` returns before loading the vimrc then, so
  // the surface that needs the mappings loads them itself (load once).
  useEffect(() => {
    if (vim) void ensureVimrcLoaded().catch(() => {});
  }, [vim]);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          // CM turns the native selection off for its own painter; without
          // this the selection would be invisible (the note editor hides
          // ::selection globally and paints .cm-selectionBackground).
          drawSelection(),
          EditorView.lineWrapping,
          // The panel's keys are routed in the capture phase; this keymap is
          // the editor's own (typing, clipboard chords — wry delivers ⌘C/⌘V as
          // plain keydowns, so they must be bound explicitly, like the notes
          // editor does).
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            { key: "Mod-c", run: copySelection },
            { key: "Mod-x", run: cutSelection },
            { key: "Mod-v", run: pasteClipboard },
          ]),
          compartments.vim.of([]),
          compartments.commandMap.of([]),
          compartments.placeholder.of([]),
          compartments.readOnly.of([]),
          compartments.contentAttributes.of([]),
          imeSwitchExtension(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged && !update.selectionSet) return;
            const text = update.state.doc.toString();
            handlers.current.onChange(text, update.state.selection.main.head, update.docChanged);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const unregister = registerVimSurface(view);
    controller.current = {
      focus: () => view.focus(),
      text: () => view.state.doc.toString(),
      setText: (text, caret = text.length) => {
        const current = view.state.doc.toString();
        const anchor = Math.max(0, Math.min(caret, text.length));
        if (current === text) {
          view.dispatch({ selection: { anchor } });
          return;
        }
        view.dispatch({
          changes: { from: 0, to: current.length, insert: text },
          selection: { anchor },
        });
      },
      selection: () => ({
        from: view.state.selection.main.from,
        to: view.state.selection.main.to,
      }),
      mode: () => currentVimMode(view),
      enterInsert: () => {
        const cm = getCM(view);
        if (cm && currentVimMode(view) !== "insert") Vim.handleKey(cm, "i", "user");
      },
      view: () => view,
    };
    return () => {
      controller.current = null;
      unregister();
      viewRef.current = null;
      view.destroy();
    };
  }, [controller, compartments]);

  // ---- vim: the shared engine, mounted from the global switch ----
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.vim.reconfigure(
          vim
            ? [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()]
            : [],
        ),
        compartments.commandMap.reconfigure(vim ? commandMappingKeymap(mappings) : []),
      ],
    });
  }, [vim, mappings, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.placeholder.reconfigure(
        placeholder ? placeholderExtension(placeholder) : [],
      ),
    });
  }, [placeholder, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, compartments]);

  // The text focus attributes: with vim off this is the Chinese writing field
  // it always was — `data-ime-chinese` must sit on the focused element itself
  // (the content DOM) for focusInChineseField to see it; with vim on the mode
  // decides the source, so the marker is dropped.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.contentAttributes.reconfigure(
        EditorView.contentAttributes.of({
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
          ...(vim ? {} : { "data-ime-chinese": "true" }),
        }),
      ),
    });
  }, [vim, compartments]);

  return (
    <div
      ref={hostRef}
      className="agent-input"
      onKeyDownCapture={onKeyDownCapture}
      onPasteCapture={onPasteCapture}
      onFocus={() => imeOnComposerFocus(true)}
      // A click must re-assert the mode even when the box already has the
      // focus (the focus event does not fire twice).
      onPointerDown={() => imeOnComposerFocus(true)}
      onBlur={onBlur}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    />
  );
}
