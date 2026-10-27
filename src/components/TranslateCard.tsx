import { useLayoutEffect, useRef, useState } from "react";
import type { DictEntry } from "@/lib/tauri";

/**
 * 选中翻译的浮层卡片(PDF 正文用)。
 *
 * 单词/句子的分流在 Rust 完成,这里只渲染四种结果。卡片用 fixed 定位在
 * 选区附近,并夹在视口内;不抢焦点、不改变原生选区。网页正文的同款卡片由
 * 注入运行时在页面自己的 shadow DOM 里画(见 webAnnotations.ts)。
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

  // 量一次实际高度/宽度再夹进视口:下方放不下就翻到选区上方,窄栏时用
  // 量出来的实际宽度(不是常量)算左右边界。选区坐标是 mouseup 的 client
  // 坐标,不随滚动变化——滚动时父组件直接关卡片。
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
        // 不让卡片的点击冒泡成新的正文手势;卡片里的译文仍可正常选中复制。
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
