import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { dailyDayOf, dailyPathFor } from "@/daily/model";
import { dailyScaffoldWithRollover } from "@/daily/engine";
import { tauriIO } from "@/daily/runtime";
import { todayStamp } from "@/editor/ops";
import { refreshTree } from "@/app/actions";
import { focusEditor } from "@/editor/api";
import { setActiveKeyRegion } from "@/commands/globalKeys";
import { PaneEditor } from "./PaneEditor";
import { TODO_DRAG_MIME, decodeTodoDrag } from "@/projects/drag";
import { sendTodoWithToast } from "@/projects/send";

/**
 * 日期标签:今天明说,其余日子带星期(日记是按日子翻的,星期比「周几」好认)。
 */
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(day: string, today: string): string {
  const d = new Date(`${day}T00:00:00`);
  const wd = Number.isNaN(d.getTime()) ? "" : WEEKDAY[d.getDay()];
  if (day === today) return `今天 · ${day}`;
  return wd ? `${day} · ${wd}` : day;
}

/**
 * 项目视图右栏:只放日记(`<vault>/Daily/YYYY-MM-DD.md`)。
 *
 * 这里不经过全局 `currentFile` / `openNote`:项目视图里活动编辑器可能是项目
 * 卡片,把日记塞进它就会写错文件。日记的读写、自动保存都由这块自己负责。
 *
 * 待办拖进来的落点就是「今天待办区的最前面」——与卡片上的发送快捷键同一条
 * 路径(sendTodoToTodayFront),拖到哪一行都不改变插入位置。
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

  // 默认落点:今天 → 最新一篇 → 空(等发送时创建)。用户选过之后不再自动改。
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

  // 当前日记被外部删掉时回到今天的落点,别停在一份不存在的文件上。
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
      const text = await dailyScaffoldWithRollover(tauriIO, vaultRoot, today);
      await api.writeFile(path, text);
      await refreshTree();
    }
    setCurrent(path);
    focusEditor(viewRef.current);
  };

  const isTodoDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(TODO_DRAG_MIME);

  const idx = current ? days.findIndex((d) => d.path === current) : -1;
  /** 更早的一篇(列表是降序,index 更大)。 */
  const older = idx >= 0 && idx + 1 < days.length ? days[idx + 1] : null;
  /** 更晚的一篇。 */
  const newer = idx > 0 ? days[idx - 1] : null;
  const currentDay = idx >= 0 ? days[idx].day : null;

  // 「聚焦日记区」命令只发信号:编辑器实例在组件里,命令层拿不到。
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
    // 拖进来的是项目待办:接管落点,不让 CodeMirror 把它当文本插入。
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
          {/* 原生下拉铺满日期文字(透明),点日期即选任意一天:外观由 CSS 决定,
              交互仍是系统原生的翻找体验。 */}
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
