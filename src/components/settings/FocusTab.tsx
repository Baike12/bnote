import { useEffect } from "react";
import { openAccessibilitySettings, useFocusStore } from "@/focus/store";
import { MinutesInput } from "@/components/MinutesInput";
import { isActive, MAX_FOCUS_DURATIONS } from "@/focus/timer";
import { SettingsCard, Row } from "./primitives";

export function FocusTab() {
  const timer = useFocusStore((s) => s.timer);
  const setDurations = useFocusStore((s) => s.setDurations);
  const trusted = useFocusStore((s) => s.trusted);
  const hardLock = useFocusStore((s) => s.hardLock);
  const hardActive = useFocusStore((s) => s.hardActive);
  const pendingHardLock = useFocusStore((s) => s.pendingHardLock);
  const error = useFocusStore((s) => s.error);
  const refreshStatus = useFocusStore((s) => s.refreshStatus);
  const active = isActive(timer);

  // The native state is read once again when this page is opened: the accessibility permission may have just been granted in the system settings.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const hardText = hardActive
    ? "拦截中"
    : pendingHardLock
      ? "等待授权"
      : hardLock
        ? "已武装(开始专注时拦截)"
        : trusted
          ? "开始专注时自动武装"
          : "未授权";

  return (
    <div className="settings-section">
      <SettingsCard title="番茄钟">
        <Row
          label="可选时长"
          desc="状态栏左下角按这里列出的时长各显示一个可点的按钮"
          control={
            <DurationList
              durations={timer.config.focusDurations}
              onChange={(focusDurations) => setDurations({ focusDurations })}
            />
          }
        />
        <div className="setting-hint">
          {active
            ? "本次专注进行中:不能暂停、不能提前结束。改时长只影响下一段。"
            : "点状态栏左下角的时间开始对应时长的专注。开始后独占屏幕与硬锁同时生效,到点才解锁;最多三个时长,相同的时间只保留一个。"}
        </div>
      </SettingsCard>

      <SettingsCard title="专注锁">
        <Row label="独占屏幕" control={<span className="setting-value">专注期间始终开启</span>} />
        <Row label="硬锁" control={<span className="setting-value">{hardText}</span>} />
        <Row
          label="辅助功能"
          control={
            trusted && !pendingHardLock ? (
              <span className="setting-value">已授权</span>
            ) : (
              <button className="link-btn" onClick={() => void openAccessibilitySettings()}>
                {pendingHardLock ? "等待授权 · 去设置" : "去授权"}
              </button>
            )
          }
        />
        {error && !pendingHardLock && <div className="setting-error">{error}</div>}
      </SettingsCard>
    </div>
  );
}

/**
 * The durations the status bar offers: one input per entry, one to three in
 * total.
 *
 * Every edit commits the whole list: the timer state is the single owner, and
 * `normalizeConfig` drops duplicates and caps the length, so this control cannot
 * produce a list the status bar is unable to render.
 */

function DurationList({
  durations,
  onChange,
}: {
  durations: number[];
  onChange: (durations: number[]) => void;
}) {
  return (
    <div className="setting-durations">
      {durations.map((minutes, index) => (
        <span className="setting-duration" key={index}>
          <MinutesInput
            className="settings-input mono"
            value={minutes}
            onChange={(next) => onChange(durations.map((m, i) => (i === index ? next : m)))}
          />
          {durations.length > 1 && (
            <button
              type="button"
              className="setting-duration-remove"
              title="删除这个时长"
              onClick={() => onChange(durations.filter((_, i) => i !== index))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {durations.length < MAX_FOCUS_DURATIONS && (
        <button
          type="button"
          className="link-btn"
          title="再加一个可选时长"
          onClick={() => onChange([...durations, suggestedDuration(durations)])}
        >
          + 添加
        </button>
      )}
    </div>
  );
}

/** A duration that is not in the list yet, so a new row always yields a new chip. */

function suggestedDuration(durations: number[]): number {
  for (const candidate of [25, 45, 50, 60, 90]) {
    if (!durations.includes(candidate)) return candidate;
  }
  return Math.min(180, Math.max(...durations) + 30);
}
