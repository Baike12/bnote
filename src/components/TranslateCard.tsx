import { useLayoutEffect, useRef, useState } from "react";
import type { DictEntry } from "@/lib/tauri";

/**
 * Overlay card for the selection translation (used in the PDF body).
 *
 * The word/sentence split happens in Rust, this component only renders the
 * four outcomes. The card is positioned fixed near the selection and clamped
 * into the viewport; it takes no focus and does not change the native
 * selection. The same card for web page bodies is drawn by the injected
 * runtime in the page's own shadow DOM (see webAnnotations.ts).
 */
export type TranslateCardState =
  | { id: number; status: "loading"; text: string; x: number; y: number }
  | {
      id: number;
      status: "word";
      text: string;
      x: number;
      y: number;
      entry: DictEntry;
    }
  | { id: number; status: "miss"; text: string; x: number; y: number; word: string }
  | {
      id: number;
      status: "sentence";
      text: string;
      x: number;
      y: number;
      translation: string;
    }
  | { id: number; status: "error"; text: string; x: number; y: number; message: string };

const MARGIN = 10;

export function TranslateCard({
  state,
  onClose,
}: {
  state: TranslateCardState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // Measure the real height/width once and clamp it into the viewport: flip
  // above the selection when it does not fit below, and compute the
  // horizontal bounds from the measured width (not a constant) in a narrow
  // column. The selection coordinates are the client coordinates of the
  // mouseup and do not follow a scroll, so the parent closes the card when
  // the page scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = state.x + 12;
    if (left + width + MARGIN > vw) left = state.x - width - 12;
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    let top = state.y + 18;
    if (top + height + MARGIN > vh) top = state.y - height - 12;
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN));
    setPos({ left, top });
  }, [state.x, state.y, state.status, state.id]);

  return (
    <div
      className={`translate-card status-${state.status}`}
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => {
        // Do not let a click on the card bubble up as a new gesture on the body text; the translation inside the card can still be selected and copied as usual.
        e.stopPropagation();
      }}
      onMouseUp={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="选中翻译"
    >
      <div className="translate-card-head">
        <span className="translate-card-title">
          {state.status === "word"
            ? state.entry.word
            : state.status === "miss"
              ? state.word
              : state.status === "sentence"
                ? "句子翻译"
                : state.status === "error"
                  ? "翻译失败"
                  : "查询中…"}
        </span>
        <button
          className="translate-card-close"
          title="关闭"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      <div className="translate-card-body">
        {state.status === "loading" && (
          <p className="translate-card-dim">正在查询内置词典或翻译模型…</p>
        )}
        {state.status === "word" && (
          <>
            {state.entry.phonetic && (
              <div className="translate-card-phonetic mono">
                /{state.entry.phonetic}/
              </div>
            )}
            {state.entry.translation
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line, i) => (
                <p key={i} className="translate-card-line">
                  {line}
                </p>
              ))}
          </>
        )}
        {state.status === "miss" && (
          <>
            <p className="translate-card-line">内置词典未收录这个词。</p>
            <p className="translate-card-dim">
              选中两个及以上单词可调用模型翻译。
            </p>
          </>
        )}
        {state.status === "sentence" && (
          <p className="translate-card-line">{state.translation}</p>
        )}
        {state.status === "error" && (
          <p className="translate-card-error">{state.message}</p>
        )}
      </div>
      <div className="translate-card-foot">
        {state.status === "word" && "内置词典"}
        {state.status === "miss" && "本地查询 · 未收录"}
        {state.status === "sentence" && "模型翻译"}
        {state.status === "error" && "未发送译文"}
        {state.status === "loading" && "…"}
      </div>
    </div>
  );
}
