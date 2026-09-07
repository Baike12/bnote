import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { fuzzySort } from "@/lib/fuzzy";
import { useAppStore } from "@/state/appStore";
import { quickAddNote } from "@/app/actions";
import { api } from "@/lib/tauri";

/**
 * Quick add (Obsidian QuickAdd-style, simplified): pick one of the configured
 * quick-add commands via fuzzy search, then name the note. The file lands in
 * the command's folder, which is created at the vault root when missing.
 */
export function QuickAddModal() {
  const open = useAppStore((s) => s.modal === "quickadd");
  const setModal = useAppStore((s) => s.setModal);
  const commands = useAppStore((s) => s.settings.quickAdd);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<{ name: string; folder: string } | null>(null);
  const [name, setName] = useState("");

  // Reset the two-stage flow every time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setPicked(null);
      setName("");
    }
  }, [open]);

  // The pick stage is ASCII search (command names) — switch to the English
  // input source like the quick switcher; naming a note may be Chinese, so
  // the source is restored as soon as a command is picked.
  useEffect(() => {
    if (!open || picked) return;
    const { settings } = useAppStore.getState();
    if (!settings.ime.enabled) return;
    let prevSource: string | null = null;
    let closed = false;
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (closed) return api.setInputSource(id).catch(() => {});
        prevSource = id;
        return api.setInputSource(settings.ime.normalSource);
      })
      .catch(() => {});
    return () => {
      closed = true;
      if (prevSource) void api.setInputSource(prevSource).catch(() => {});
    };
  }, [open, picked]);

  const results = useMemo(
    () => fuzzySort(commands, (c) => `${c.name} ${c.folder}`, query.trim()),
    [commands, query],
  );

  const close = () => setModal(null);

  const pick = (i: number) => {
    const cmd = results[i]?.item;
    if (!cmd) return;
    setQuery("");
    setIndex(0);
    setPicked(cmd);
  };

  const create = () => {
    if (!picked || !name.trim()) return;
    close();
    void quickAddNote(picked.folder, name);
  };

  if (commands.length === 0) {
    return (
      <Modal open={open} onClose={close} width={620}>
        <div className="switcher">
          <div className="switcher-empty">还没有快速添加命令，先到「设置 → 快速添加」中配置</div>
          <div className="qa-modal-actions">
            <button
              className="btn"
              onClick={() => {
                close();
                useAppStore.getState().setModal("settings");
              }}
            >
              打开设置
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} width={620}>
      <div className="switcher">
        {picked ? (
          <>
            <input
              autoFocus
              className="switcher-input"
              placeholder={`文件名（创建在 ${picked.folder || "仓库根目录"}）…`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  setPicked(null);
                }
              }}
            />
            <div className="switcher-results">
              <div
                className="switcher-row active"
                onMouseDown={(e) => {
                  e.preventDefault();
                  create();
                }}
              >
                <span className="switcher-name">{name.trim() || "输入文件名…"}</span>
                <span className="switcher-path">{picked.folder || "仓库根目录"}</span>
              </div>
              <div className="switcher-hint">Tab 返回命令选择 · Enter 创建文件</div>
            </div>
          </>
        ) : (
          <>
            <input
              autoFocus
              className="switcher-input"
              placeholder="搜索快速添加命令…"
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
                  pick(index);
                }
              }}
            />
            <div className="switcher-results">
              {results.map(({ item: cmd }, i) => (
                <div
                  key={`${cmd.name}-${cmd.folder}`}
                  className={`switcher-row${i === index ? " active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  <span className="switcher-name">{cmd.name}</span>
                  <span className="switcher-path">{cmd.folder || "仓库根目录"}</span>
                </div>
              ))}
              {results.length === 0 && <div className="switcher-empty">无匹配命令</div>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
