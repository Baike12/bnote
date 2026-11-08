import { Fragment, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/state/appStore";
import { useFocusStore } from "@/focus/store";
import {
  BLOCK_BREAK_MINUTES,
  BLOCK_FOCUS_MINUTES,
  HOURS_PER_DAY,
  rectangleCells,
  weekDays,
  type DayKey,
  type GridCell,
} from "@/focus/schedule";
import { SettingsCard } from "./primitives";

/**
 * The scheduled focus week: a heatmap whose rows are the seven rolling days
 * (today plus six) and whose columns are the 24 hourly blocks.
 *
 * The grid edits a **draft**, never the saved schedule: a pointer release only
 * ends the rectangle, and nothing is applied until the Save button is pressed -
 * a drag is a multi-segment selection, not a command. Saved cells are locked:
 * the schedule is append-only (see focus/schedule.ts), so a day that was set
 * cannot be cancelled here and the row only ever gains blocks.
 *
 * Dragging is handled with pointer events. The anchor/current pair lives in a
 * ref because a fast drag must not wait for React to re-render; the rectangle
 * is mirrored into state only to paint the preview.
 */

interface Drag {
  anchor: GridCell;
  current: GridCell;
  moved: boolean;
}

const WEEKDAYS = "日一二三四五六";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "今天 11/07" / "周六 11/08"; keys come from `weekDays`, so the split is safe. */
function dayLabel(day: DayKey, today: DayKey): string {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(year, month - 1, date).getDay();
  const prefix = day === today ? "今天" : `周${WEEKDAYS[weekday]}`;
  return `${prefix} ${pad2(month)}/${pad2(date)}`;
}

export function FocusScheduleCard() {
  const schedule = useFocusStore((s) => s.schedule);
  const saveSchedule = useFocusStore((s) => s.saveSchedule);
  const [now, setNow] = useState(() => new Date());
  const [draft, setDraft] = useState<Record<DayKey, Set<number>>>({});
  const [preview, setPreview] = useState<readonly GridCell[] | null>(null);
  const drag = useRef<Drag | null>(null);

  // The rolling window is recomputed while the page stays open: the settings
  // modal can be left open across midnight, and then both the rows and the
  // draft keyed on yesterday would be stale.
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(handle);
  }, []);

  const days = weekDays(now);
  const today = days[0];

  // A draft that belongs to the previous date can no longer be drawn; saving it
  // would write to an invisible row.
  useEffect(() => {
    setDraft({});
    setPreview(null);
    drag.current = null;
  }, [today]);

  const isSaved = (day: DayKey, hour: number) => schedule.days[day]?.includes(hour) ?? false;
  const isDrafted = (day: DayKey, hour: number) => draft[day]?.has(hour) ?? false;

  function toggleCell(cell: GridCell) {
    if (isSaved(cell.day, cell.hour)) return;
    setDraft((prev) => {
      const hours = new Set(prev[cell.day] ?? []);
      if (hours.has(cell.hour)) hours.delete(cell.hour);
      else hours.add(cell.hour);
      const next = { ...prev };
      if (hours.size > 0) next[cell.day] = hours;
      else delete next[cell.day];
      return next;
    });
  }

  function addCells(cells: readonly GridCell[]) {
    setDraft((prev) => {
      const next: Record<DayKey, Set<number>> = {};
      for (const [day, hours] of Object.entries(prev)) next[day] = new Set(hours);
      for (const cell of cells) {
        if (isSaved(cell.day, cell.hour)) continue;
        (next[cell.day] ??= new Set<number>()).add(cell.hour);
      }
      return next;
    });
  }

  // The pointerup listener is installed once, so the commit runs through a ref
  // that always sees the latest schedule and draft.
  const commitRef = useRef<(finished: Drag) => void>(() => {});
  useEffect(() => {
    commitRef.current = (finished) => {
      if (!finished.moved) toggleCell(finished.anchor);
      else addCells(rectangleCells(days, finished.anchor, finished.current));
    };
  });

  useEffect(() => {
    const finish = () => {
      const finished = drag.current;
      if (finished === null) return;
      drag.current = null;
      setPreview(null);
      commitRef.current(finished);
    };
    const cancel = () => {
      drag.current = null;
      setPreview(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const previewIds = new Set((preview ?? []).map((cell) => `${cell.day}:${cell.hour}`));
  const draftCount = Object.values(draft).reduce((sum, hours) => sum + hours.size, 0);

  function save() {
    const cells: GridCell[] = [];
    for (const [day, hours] of Object.entries(draft)) {
      for (const hour of hours) cells.push({ day, hour });
    }
    if (cells.length === 0) return;
    const added = saveSchedule(cells);
    setDraft({});
    useAppStore
      .getState()
      .showToast(added > 0 ? `已保存 ${added} 个专注时段` : "这些时段已经保存过");
  }

  return (
    <SettingsCard
      title="一周专注计划"
      desc={`从今天起滚动显示 7 天。每格 1 小时：前 ${BLOCK_FOCUS_MINUTES} 分钟专注，后 ${BLOCK_BREAK_MINUTES} 分钟关闭专注。`}
      actions={
        <button className="btn primary" disabled={draftCount === 0} onClick={save}>
          {draftCount > 0 ? `保存 (${draftCount})` : "保存"}
        </button>
      }
    >
      <div className="settings-block focus-schedule">
        <div className="focus-schedule-toolbar">
          <span className="focus-schedule-count">
            {draftCount > 0
              ? `草稿 ${draftCount} 段，点「保存」后才生效`
              : "拖动可框选多段，点一下切换单个时段"}
          </span>
          {draftCount > 0 && (
            <button type="button" className="link-btn" onClick={() => setDraft({})}>
              清空草稿
            </button>
          )}
        </div>

        <div className="focus-schedule-grid" onDragStart={(e) => e.preventDefault()}>
          <span />
          {Array.from({ length: HOURS_PER_DAY }, (_, hour) => (
            <span className="focus-schedule-hour" key={`hour-${hour}`}>
              {hour % 3 === 0 ? pad2(hour) : ""}
            </span>
          ))}
          {days.map((day) => (
            <Fragment key={day}>
              <span className="focus-schedule-day">{dayLabel(day, today)}</span>
              {Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
                const saved = isSaved(day, hour);
                const drafted = isDrafted(day, hour);
                const inPreview = previewIds.has(`${day}:${hour}`);
                const state = saved ? "saved" : drafted ? "draft" : "empty";
                const tone = state === "empty" ? "" : ` ${state}`;
                return (
                  <button
                    key={`${day}:${hour}`}
                    type="button"
                    className={`focus-schedule-cell${tone}${inPreview ? " preview" : ""}`}
                    data-day={day}
                    data-hour={hour}
                    data-state={state}
                    aria-pressed={saved || drafted}
                    aria-disabled={saved}
                    aria-label={`${day} ${pad2(hour)}:00 到 ${pad2(hour)}:${BLOCK_FOCUS_MINUTES} ${
                      saved ? "已保存，不可取消" : drafted ? "待保存" : "未选择"
                    }`}
                    title={`${day} ${pad2(hour)}:00–${pad2(hour)}:${BLOCK_FOCUS_MINUTES} · ${
                      saved
                        ? "已保存（不可取消）"
                        : drafted
                          ? "待保存（再点一下取消）"
                          : "点击或拖选"
                    }`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      const cell = { day, hour };
                      drag.current = { anchor: cell, current: cell, moved: false };
                      setPreview([cell]);
                    }}
                    onPointerEnter={() => {
                      const current = drag.current;
                      if (current === null) return;
                      const moved =
                        current.moved || day !== current.anchor.day || hour !== current.anchor.hour;
                      drag.current = { anchor: current.anchor, current: { day, hour }, moved };
                      setPreview(rectangleCells(days, current.anchor, { day, hour }));
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>

        <div className="focus-schedule-legend">
          <span className="focus-schedule-legend-item">
            <span className="focus-schedule-swatch" />
            未选择
          </span>
          <span className="focus-schedule-legend-item">
            <span className="focus-schedule-swatch draft" />
            草稿
          </span>
          <span className="focus-schedule-legend-item">
            <span className="focus-schedule-swatch saved" />
            已保存（不可取消）
          </span>
        </div>

        <p className="setting-hint">
          保存后到点自动开始专注，50 分钟后自动解锁，休息 10 分钟再进入下一段。计划只在 bnote
          运行时生效；到点时若已有专注在进行，这一小时不会重复开始。
        </p>
      </div>
    </SettingsCard>
  );
}
