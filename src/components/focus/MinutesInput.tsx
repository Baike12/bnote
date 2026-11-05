import { useEffect, useState } from "react";
import { parseMinutesDraft } from "@/focus/duration";

/**
 * Minutes input: draft-style editing, committed on Enter or blur.
 *
 * Writing a controlled input straight back into the store would turn
 * "clear the field" into "0 -> clamped to 1", so the user can never delete
 * the existing number. Here typing only changes the draft and only a legal
 * value is committed; Escape restores, an empty or illegal input restores
 * the current value.
 */
export function MinutesInput({
  value,
  onChange,
  className,
  min = 1,
  max = 180,
}: {
  value: number;
  onChange: (minutes: number) => void;
  className?: string;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // Follow a duration changed elsewhere (the chip, another input); while the user is editing, do not steal the caret.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = parseMinutesDraft(draft, { min, max });
    if (next === null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <input
      className={className}
      type="number"
      min={min}
      max={max}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(String(value));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
