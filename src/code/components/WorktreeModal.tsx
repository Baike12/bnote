import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "../store";
import { codeApi } from "../api";
import { openProjectAt } from "../commands";
import {
  isDirtyRefusal,
  randomWorktreeName,
  validWorktreeName,
  worktreePathFor,
  worktreesDirFor,
} from "../projectGroups";
import { useProjectSidebarStore } from "../projectSidebarStore";
import { projectLabel } from "../projectSwitch";
import type { WorktreeInfo } from "../types";

/**
 * The worktree dialog: the existing checkouts of one repository and a form
 * that creates a new one and opens it.
 *
 * The shape follows Zed's `CreateWorktree`: the user only names the worktree
 * (randomly suggested, `adjective-noun`) and picks what it starts from — a new
 * branch based on HEAD or another branch, or an existing branch checked out.
 * The **path is not a choice**: `<main repo parent>/worktrees/<repo>/<name>`,
 * anchored at the main repository, so every worktree of one repo lands next to
 * the others even when creation starts from a linked worktree. The dialog only
 * previews it; the backend owns the rule.
 *
 * Deletion lives here (ZCode keeps it in its managed-worktree dialog): the
 * open checkout and the main checkout are never offered, so a session the
 * panel is writing into cannot lose its directory.
 */
export function WorktreeModal() {
  const open = useProjectSidebarStore((s) => s.worktreeOpen);
  const target = useProjectSidebarStore((s) => s.worktreeRoot);
  const close = useProjectSidebarStore((s) => s.closeWorktreeModal);
  const project = useCodeStore((s) => s.project);

  const [mainRepo, setMainRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [base, setBase] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const root = target ?? project?.root ?? null;

  /** The branch list follows what is still checked out somewhere. */
  async function loadBranches(repo: string, list: WorktreeInfo[]) {
    const checkedOut = new Set(list.map((w) => w.branch).filter((b): b is string => !!b));
    const names = await codeApi.gitBranches(repo).catch((): string[] => []);
    return names.filter((b) => !checkedOut.has(b));
  }

  // Every open starts a fresh draft: the name must not carry over from the last
  // worktree (it would collide) and the branch lists belong to this repository.
  useEffect(() => {
    if (!open || !root) return;
    let alive = true;
    setName("");
    setMode("new");
    setBase("");
    setBranch("");
    setBusy(false);
    setError(null);
    setMainRepo(null);
    setWorktrees([]);
    setBranches([]);
    setPendingDelete(null);
    setDeleteError(null);
    void (async () => {
      const anchor = await codeApi.gitMainRepo(root).catch(() => null);
      if (!alive) return;
      const repo = anchor ?? root;
      setMainRepo(repo);
      const list = await codeApi.worktreeList(repo).catch(() => []);
      if (!alive) return;
      setWorktrees(list);
      setName(randomWorktreeName(list.map((w) => w.name)));
      // A branch that a worktree already has checked out cannot be checked out
      // again (git refuses), so the picker only offers the free ones.
      const free = await loadBranches(repo, list);
      if (!alive) return;
      setBranches(free);
      setBranch(free[0] ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [open, root]);

  if (!root) return null;

  const repo = mainRepo ?? root;
  const preview = name ? worktreePathFor(repo, name) : worktreesDirFor(repo);
  const nameOk = validWorktreeName(name);
  const branchOk = mode === "new" ? nameOk : branch !== "";
  const branchName = mode === "new" ? name : branch;

  async function create() {
    if (busy || !nameOk || !branchOk) return;
    setBusy(true);
    setError(null);
    try {
      const info = await codeApi.worktreeCreate(
        repo,
        name,
        mode === "new",
        branchName,
        mode === "new" && base ? base : null,
      );
      close();
      // The sidebar's checkout list and the opened project both change.
      const { recentCodeProjects } = useAppStore.getState();
      void useProjectSidebarStore.getState().refresh(recentCodeProjects);
      await openProjectAt(info.path);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function removeWorktree(path: string, force: boolean) {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await codeApi.worktreeRemove(repo, path, force);
      setPendingDelete(null);
      const list = await codeApi.worktreeList(repo).catch(() => []);
      setWorktrees(list);
      setBranches(await loadBranches(repo, list));
      const { recentCodeProjects } = useAppStore.getState();
      await useProjectSidebarStore.getState().refresh(recentCodeProjects);
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open={open} onClose={close} width={520}>
      <div className="worktree-modal">
        <div className="worktree-modal-head">
          <span className="worktree-modal-title">Worktree</span>
          <span className="worktree-modal-repo" title={repo}>
            {projectLabel(repo)}
          </span>
        </div>

        {worktrees.length > 0 && (
          <div className="worktree-existing">
            <span className="worktree-label">已有 Worktree</span>
            {worktrees.map((item) => {
              const isOpen = item.path === project?.root;
              const removable = !item.isMain && !isOpen;
              const confirming = pendingDelete === item.path;
              return (
                <div className="worktree-row" key={item.path}>
                  <span className="worktree-row-name">
                    {item.isMain ? "主仓库" : item.name}
                    <span className="worktree-row-path" title={item.path}>
                      {item.path}
                    </span>
                  </span>
                  <span className="worktree-row-branch">
                    {item.branch ?? (item.isDetached ? "detached" : "")}
                  </span>
                  {isOpen && <span className="worktree-row-note">当前打开</span>}
                  {removable &&
                    (confirming ? (
                      <>
                        <button
                          type="button"
                          className="archive-act danger"
                          disabled={deleting}
                          onClick={() => void removeWorktree(item.path, false)}
                        >
                          {deleting ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          type="button"
                          className="archive-act"
                          disabled={deleting}
                          onClick={() => setPendingDelete(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="cp-row-action is-visible"
                        title="删除 worktree"
                        onClick={() => {
                          setDeleteError(null);
                          setPendingDelete(item.path);
                        }}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    ))}
                </div>
              );
            })}
            {deleteError && (
              <p className="worktree-hint error">
                {isDirtyRefusal(deleteError)
                  ? `${deleteError}\n工作区有未提交的改动:可强制删除。`
                  : deleteError}
              </p>
            )}
            {isDirtyRefusal(deleteError) && pendingDelete && (
              <div className="worktree-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={deleting}
                  onClick={() => void removeWorktree(pendingDelete, true)}
                >
                  强制删除
                </button>
              </div>
            )}
          </div>
        )}

        <div className="worktree-create">
          <span className="worktree-label">新建 Worktree</span>
          <label className="worktree-field">
            <span className="worktree-label">名称</span>
            <input
              autoFocus
              className="worktree-input"
              value={name}
              placeholder="例如 calm-river"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {!nameOk && name !== "" && (
            <p className="worktree-hint error">名称不能包含 / \ .. 或以 . 开头</p>
          )}

          <div className="worktree-field">
            <span className="worktree-label">起点</span>
            <div className="worktree-segmented">
              <button
                type="button"
                className={mode === "new" ? "is-active" : ""}
                onClick={() => setMode("new")}
              >
                新分支
              </button>
              <button
                type="button"
                className={mode === "existing" ? "is-active" : ""}
                onClick={() => setMode("existing")}
              >
                现有分支
              </button>
            </div>
          </div>

          {mode === "new" ? (
            <label className="worktree-field">
              <span className="worktree-label">基于</span>
              <select
                className="worktree-input"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              >
                <option value="">当前 HEAD</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <span className="worktree-hint">新分支名与名称相同:{name || "…"}</span>
            </label>
          ) : (
            <label className="worktree-field">
              <span className="worktree-label">分支</span>
              <select
                className="worktree-input"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              {branches.length === 0 && <span className="worktree-hint">没有本地分支</span>}
            </label>
          )}

          <label className="worktree-field">
            <span className="worktree-label">位置</span>
            <code className="worktree-path" title={preview}>
              {preview}
            </code>
          </label>

          {error && <p className="worktree-hint error">{error}</p>}

          <div className="worktree-actions">
            <button type="button" className="btn" onClick={close} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void create()}
              disabled={busy || !nameOk || !branchOk}
            >
              {busy ? "创建中…" : "创建并打开"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
