import { useEffect, useState } from "react";
import { parseMinutesDraft } from "@/focus/duration";

/**
 * 分钟输入框:草稿式编辑,回车/失焦才提交。
 *
 * 受控输入直接写回 store 会让"清空"变成"0 → 夹到 1",用户删不掉原来的数字。
 * 这里输入过程中只改草稿,合法才提交;Esc 还原,空/非法输入还原成当前值。
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

  // 别的地方改了时长(芯片/另一处输入框)时跟上;正在编辑就别抢用户的光标。
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
