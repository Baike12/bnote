import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { fuzzySort } from "@/lib/fuzzy";
import { allCommands } from "@/commands/registry";
import { bindingsForCommand, formatBinding } from "@/commands/keys";
import { useAppStore } from "@/state/appStore";

export function CommandPalette() {
  const open = useAppStore((s) => s.modal === "palette");
  const setModal = useAppStore((s) => s.setModal);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const commands = useMemo(() => allCommands(), []);
  const results = useMemo(
    () => fuzzySort(commands, (c) => `${c.category} ${c.title}`, query.trim()),
    [commands, query],
  );

  const close = () => {
    setModal(null);
    setQuery("");
    setIndex(0);
  };

  const run = (i: number) => {
    const cmd = results[i]?.item;
    close();
    if (cmd) void cmd.run();
  };

  return (
    <Modal open={open} onClose={close} width={620}>
      <div className="switcher">
        <input
          autoFocus
          className="switcher-input"
          placeholder="输入命令…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(index);
            }
          }}
        />
        <div className="switcher-results">
          {results.map(({ item }, i) => (
            <div
              key={item.id}
              className={`switcher-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(i);
              }}
            >
              <span className="switcher-name">{item.title}</span>
              <span className="switcher-binding">
                {bindingsForCommand(item.id)
                  .map(formatBinding)
                  .join(" / ")}
              </span>
            </div>
          ))}
          {results.length === 0 && <div className="switcher-empty">无匹配命令</div>}
        </div>
      </div>
    </Modal>
  );
}
