import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { dailyDayOf, dailyPathFor } from "@/daily/model";
import { dailyScaffoldWithRollover } from "@/daily/engine";
import { dailyTemplatePath, tauriIO } from "@/daily/runtime";
import { todayStamp } from "@/editor/ops";
import { refreshTree } from "@/app/actions";
import { focusEditor } from "@/editor/api";
import { setActiveKeyRegion } from "@/commands/globalKeys";
import { PaneEditor } from "./PaneEditor";
import { TODO_DRAG_MIME, decodeTodoDrag } from "@/projects/drag";
import { sendTodoWithToast } from "@/projects/send";

/**
 * Date label: today is spelled out, other days carry their weekday (daily
 * notes are flipped through by day, and the weekday is easier to recognise
 * than a bare number).
 */
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(day: string, today: string): string {
  const d = new Date(`${day}T00:00:00`);
  const wd = Number.isNaN(d.getTime()) ? "" : WEEKDAY[d.getDay()];
  if (day === today) return `今天 · ${day}`;
  return wd ? `${day} · ${wd}` : day;
}

/**
 * Right column of the project view: daily notes only
 * (`<vault>/Daily/YYYY-MM-DD.md`).
 *
 * It does not go through the global `currentFile` / `openNote`: in the
 * project view the active editor may be a project card, and pushing a daily
 * note into it would write the wrong file. Reading, writing and autosaving
 * the daily note are all handled here.
 *
 * A dropped todo always lands at the very top of today's todo list, the
 * same path the card's send shortcut takes (sendTodoToTodayFront); the
 * drop position does not change where it is inserted.
 */
export function DailyNotePane() {
  const vaultRoot = useAppStore((s) => s.vaultPath);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const [current, setCurrent] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const today = todayStamp();

  const days = useMemo(() => {
    if (!vaultRoot) return [];
    const root = vaultRoot.replace(/\/+$/, "");
    const out: { day: string; path: string }[] = [];
    for (const rel of flatFiles) {
      const abs = `${root}/${rel}`;
      const day = dailyDayOf(abs);
      if (day) out.push({ day, path: abs });
    }
    out.sort((a, b) => b.day.localeCompare(a.day));
    return out;
  }, [flatFiles, vaultRoot]);

  const todayPath = vaultRoot ? dailyPathFor(vaultRoot, today) : null;

  // Default landing spot: today -> the most recent one -> empty (created when something is sent). Once the user picked a day, it is never changed automatically again.
  useEffect(() => {
    if (!vaultRoot) {
      setCurrent(null);
      return;
    }
    setCurrent((prev) => {
      if (prev) return prev;
      if (todayPath && days.some((d) => d.path === todayPath)) return todayPath;
      return days[0]?.path ?? null;
    });
  }, [vaultRoot, todayPath, days]);

  // When the current daily note is deleted externally, fall back to today's landing spot instead of staying on a file that no longer exists.
  useEffect(() => {
    if (!vaultRoot || !current) return;
    if (days.some((d) => d.path === current)) return;
    setCurrent(todayPath);
  }, [days, current, todayPath, vaultRoot]);

  const openToday = async () => {
    if (!vaultRoot) return;
    const path = dailyPathFor(vaultRoot, today);
    try {
      await api.readFile(path);
    } catch {
      const text = await dailyScaffoldWithRollover(tauriIO, vaultRoot, today, dailyTemplatePath());
      await api.writeFile(path, text);
      await refreshTree();
    }
    setCurrent(path);
    focusEditor(viewRef.current);
  };

  const isTodoDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(TODO_DRAG_MIME);

  const idx = current ? days.findIndex((d) => d.path === current) : -1;
  /** An earlier day (the list is descending, so a larger index). */
  const older = idx >= 0 && idx + 1 < days.length ? days[idx + 1] : null;
  /** A later day. */
  const newer = idx > 0 ? days[idx - 1] : null;
  const currentDay = idx >= 0 ? days[idx].day : null;

  // The "focus the daily note area" command only emits a signal: the editor instance lives in this component and the command layer cannot reach it.
  useEffect(() => {
    const focusDaily = () => {
      setActiveKeyRegion("notes");
      focusEditor(viewRef.current);
    };
    window.addEventListener("bnote:focus-daily", focusDaily);
    return () => window.removeEventListener("bnote:focus-daily", focusDaily);
  }, []);

  const onDragOver = (e: DragEvent) => {
    if (!isTodoDrag(e)) return;
    // What is dragged in is a project todo: take over the drop so CodeMirror does not insert it as text.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropActive(false);
  };

  const onDrop = (e: DragEvent) => {
    if (!isTodoDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const payload = decodeTodoDrag(e.dataTransfer.getData(TODO_DRAG_MIME));
    if (!payload) return;
    void sendTodoWithToast(payload);
  };

  return (
    <section
      className={`projects-daily${dropActive ? " drop-target" : ""}`}
      data-key-region="notes"
      onDragOverCapture={onDragOver}
      onDragLeaveCapture={onDragLeave}
      onDropCapture={onDrop}
    >
      <div className="projects-daily-head" data-tauri-drag-region="deep">
        <button
          className="daily-nav prev"
          disabled={!older}
          title={older ? `前一天（${older.day}）` : "没有更早的日记"}
          onClick={() => older && setCurrent(older.path)}
        >
          ‹
        </button>
        <div className="daily-date">
          <span className="daily-date-text">
            {currentDay ? dayLabel(currentDay, today) : "还没有日记"}
          </span>
          {/* The native dropdown spreads over the date text (transparent), so
              clicking a date selects any day: the look comes from CSS, the
              interaction stays the system's native pick-and-scroll one. */}
          <select
            className="daily-date-select"
            value={current ?? ""}
            onChange={(e) => setCurrent(e.target.value || null)}
            title="打开以往的日记"
          >
            {days.length === 0 && <option value="">还没有日记</option>}
            {days.map((d) => (
              <option key={d.path} value={d.path}>
                {d.day === today ? `${d.day}（今天）` : d.day}
              </option>
            ))}
          </select>
        </div>
        <button
          className="daily-nav next"
          disabled={!newer}
          title={newer ? `后一天（${newer.day}）` : "没有更新的日记"}
          onClick={() => newer && setCurrent(newer.path)}
        >
          ›
        </button>
        {current !== todayPath && (
          <button className="daily-today" title="打开今日日记" onClick={() => void openToday()}>
            今天
          </button>
        )}
      </div>
      {current ? (
        <PaneEditor
          path={current}
          className="projects-daily-editor"
          load={(path) => api.readFile(path)}
          save={(path, text) => api.writeFile(path, text)}
          onViewChange={(view) => {
            viewRef.current = view;
          }}
        />
      ) : (
        <div className="projects-daily-empty">
          <p>今天还没有日记。</p>
          <p>把项目里的待办拖进来，或点右上角「今天」。</p>
        </div>
      )}
    </section>
  );
}
