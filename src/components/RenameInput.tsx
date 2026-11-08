import { useEffect, useRef, useState } from "react";

/**
 * Inline rename field, shared by the file tree and the study materials list.
 *
 * Enter and blur commit the trimmed value; Escape commits an empty string,
 * which every caller treats as "cancel" (nothing to rename). The initial text
 * is selected, so typing replaces the old name instead of appending to it.
 */
export function RenameInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(value.trim());
        if (e.key === "Escape") onCommit("");
      }}
      onBlur={() => onCommit(value.trim())}
    />
  );
}
