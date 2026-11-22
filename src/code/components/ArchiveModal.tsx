import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { homeApi } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "../store";
import { mergeGroupSessions, relativeTime } from "../projectGroups";
import { useProjectSidebarStore } from "../projectSidebarStore";
import { IconRestore, IconTrash, IconWorktree } from "./ProjectIcons";
import type { ProjectGroup, ProjectSessionItem } from "../projectGroups";

/**
 * The archived sessions of one project group (main repository plus worktrees).
 *
 * ZCode's archive semantics, on bnote's file model: an archived session is
 * hidden from the task list but its transcript stays on disk; restoring puts
 * it back, deleting removes it for good. The list reloads whenever the
 * sidebar's snapshot changes (a restore or delete refreshes the store), so
 * this dialog never holds a second copy of that data across a write.
 */
export function ArchiveModal({
  open,
  onClose,
  group,
}: {
  open: boolean;
  onClose: () => void;
  group: ProjectGroup | null;
}) {
  const recent = useAppStore((s) => s.recentCodeProjects);
  const project = useCodeStore((s) => s.project);
  const refresh = useProjectSidebarStore((s) => s.refresh);

  const [items, setItems] = useState<ProjectSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const rowKey = (item: ProjectSessionItem) => `${item.workdir}:${item.id}`;

  useEffect(() => {
    if (!open || !group) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setPendingDelete(null);
    void (async () => {
      const batches = await Promise.all(
        group.checkouts.map(async (checkout) => ({
          workdir: checkout.path,
          sessions: await homeApi.sessionsArchived(checkout.path).catch(() => []),
        })),
      );
      if (!alive) return;
      setItems(mergeGroupSessions(group.checkouts, batches, 0));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [open, group]);

  async function restore(item: ProjectSessionItem) {
    if (busy) return;
    setBusy(rowKey(item));
    setError(null);
    try {
      await homeApi.unarchiveSession(item.workdir, item.id);
      await refresh(recent, project?.root ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: ProjectSessionItem) {
    if (busy) return;
    setBusy(rowKey(item));
    setError(null);
    try {
      await homeApi.deleteSession(item.workdir, item.id);
      setPendingDelete(null);
      await refresh(recent, project?.root ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={520}>
      <div className="worktree-modal">
        <div className="worktree-modal-head">
          <span className="worktree-modal-title">已归档</span>
          <span className="worktree-modal-repo" title={group?.key}>
            {group?.name}
          </span>
        </div>
        <p className="worktree-hint">
          归档的会话不显示在任务列表中，记录仍保留在磁盘上。可以恢复到列表，或永久删除。
        </p>

        {error && <p className="worktree-hint error">{error}</p>}

        {loading ? (
          <p className="worktree-hint">正在读取…</p>
        ) : items.length === 0 ? (
          <p className="worktree-hint">没有已归档的会话</p>
        ) : (
          <div className="archive-list">
            {items.map((item) => {
              const key = rowKey(item);
              const confirming = pendingDelete === key;
              return (
                <div className="archive-row" key={key}>
                  <span className="archive-row-title" title={`${item.title}\n${item.workdir}`}>
                    {item.title}
                  </span>
                  {item.isWorktree && (
                    <span className="cp-worktree" title={`Worktree ${item.sourceName}`}>
                      <IconWorktree />
                    </span>
                  )}
                  <span className="cp-time">{relativeTime(item.updatedAt)}</span>
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        className="archive-act danger"
                        disabled={busy !== null}
                        onClick={() => void remove(item)}
                      >
                        {busy === key ? "删除中…" : "确认删除"}
                      </button>
                      <button
                        type="button"
                        className="archive-act"
                        disabled={busy !== null}
                        onClick={() => setPendingDelete(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="archive-act"
                        title="恢复到任务列表"
                        disabled={busy !== null}
                        onClick={() => void restore(item)}
                      >
                        <IconRestore />
                      </button>
                      <button
                        type="button"
                        className="archive-act danger"
                        title="永久删除"
                        disabled={busy !== null}
                        onClick={() => setPendingDelete(key)}
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="worktree-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
