import { type ReactNode } from "react";

// ---------------------------------------------------------------------------
// The two skeleton pieces of the settings page (following ZCode's
// SettingsGroupCard / SettingsRow): grouping into cards plus a row layout
// (label and description on the left, the control on the right).
// ---------------------------------------------------------------------------

export function SettingsCard({
  title,
  desc,
  actions,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-card">
      {(title != null || actions != null) && (
        <header className="settings-card-head">
          <div className="settings-card-head-text">
            <div className="settings-card-title">{title}</div>
            {desc && <div className="settings-card-desc">{desc}</div>}
          </div>
          {actions != null && <div className="settings-card-actions">{actions}</div>}
        </header>
      )}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

export function Row({
  label,
  desc,
  control,
}: {
  label: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {control != null && <div className="setting-control">{control}</div>}
    </div>
  );
}

/**
 * The dropdown of the settings page. The native select of WKWebView paints a
 * system gradient and the stepper arrows, which does not look like the flat
 * inputs of the page; here the native appearance is stripped
 * (-webkit-appearance: none) and the arrow is drawn in CSS, so the closed
 * state looks exactly like a .settings-input. What pops up on a click is
 * still the system menu (better native usability, no second list to build).
 */

export function SettingsSelect<T extends string>({
  value,
  onChange,
  children,
}: {
  value: T;
  onChange: (v: T) => void;
  children: ReactNode;
}) {
  return (
    <span className="settings-select-wrap">
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {children}
      </select>
    </span>
  );
}

/** A slider plus a right aligned value (the layout of ZCode's SettingsRangeControl). */

export function RangeControl({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="range-control">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="range-value">{format ? format(value) : value}</span>
    </div>
  );
}

export function Toggle({
  label,
  desc,
  checked,
  onChange,
  disabled = false,
}: {
  label: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      // The text is clickable too: a toggle is only a small dot, so users
      // will most likely click the line of text, and a click that does
      // nothing is taken for "broken" instead of "clicked the wrong spot".
      label={
        <button className="toggle-label" disabled={disabled} onClick={() => onChange(!checked)}>
          {label}
        </button>
      }
      desc={desc}
      control={
        <button
          className={`toggle${checked ? " on" : ""}`}
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span className="toggle-knob" />
        </button>
      }
    />
  );
}
