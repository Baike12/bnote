import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { startCompletion } from "@codemirror/autocomplete";
import type { CommandDef } from "@/commands/registry";
import { useAppStore } from "@/state/appStore";
import { useCodeStore } from "./store";
import { activeCodeEditor } from "./editor/registry";
import { findReferences, gotoDefinition, renameSymbol } from "./editor/goto";
import { cmToLspPosition } from "./editor/positions";
import { nextProblemTarget, type ProblemTarget } from "./problems";
import { requestCodeUi } from "./ui";

/**
 * Commands of the code project.
 *
 * They all belong to the **code region** (see the region model in
 * `src/commands/keys.ts`): they apply while the focus is in the code editor,
 * and the keybindings of the notes / reading / agent panels do not leak in,
 * and vice versa. That is the dividing line behind "the shortcuts of the code
 * editor stay separate from the others".
 *
 * The commands themselves can be rebound in the `code` section of
 * `<vault>/.bnote/keybindings.json`:
 *
 * ```json
 * { "code": { "code.go-to-definition": "F12" } }
 * ```
 */

/** Whether a project is open (used by the `when` of the commands). */
function hasProject(): boolean {
  return useCodeStore.getState().project !== null;
}

/** Whether a code editor is open. */
function hasEditor(): boolean {
  return activeCodeEditor() !== null;
}

/** The current file path (null if there is none). */
function activePath(): string | null {
  return useCodeStore.getState().activePath;
}

/** Trigger the completion panel. */
function triggerCompletion(): void {
  const handle = activeCodeEditor();
  if (!handle) return;
  startCompletion(handle.view);
  handle.view.focus();
}

/** Select the next / previous tab. */
function cycleTab(dir: 1 | -1): void {
  const store = useCodeStore.getState();
  const { tabs, activePath: current } = store;
  if (tabs.length < 2) return;
  const index = current ? tabs.indexOf(current) : -1;
  const next = tabs[(index + dir + tabs.length) % tabs.length];
  store.setActiveTab(next);
}

/** Jump to the next / previous problem (diagnostic). */
function cycleProblem(direction: 1 | -1): void {
  const store = useCodeStore.getState();
  const problems: ProblemTarget[] = Object.entries(store.diagnostics).flatMap(([path, list]) =>
    list.map((d) => ({ path, position: d.range.start })),
  );
  // The cursor is the position of the **caret**, not "the first diagnostic of
  // the current file": the latter would make the second problem of a file
  // unreachable forever (see the note in problems.ts).
  const handle = activeCodeEditor();
  const target = nextProblemTarget(
    problems,
    {
      path: handle?.path ?? store.activePath,
      position: handle
        ? cmToLspPosition(handle.view.state.doc, handle.view.state.selection.main.head)
        : null,
    },
    direction,
  );
  if (!target) return;
  void store.openFile(target.path);
  store.requestJump(target.path, target.position);
}

/** Open a project (native directory picker). */
export async function openProjectDialog(): Promise<void> {
  const selection = await openFileDialog({
    directory: true,
    title: "选择代码项目文件夹",
  });
  if (typeof selection !== "string") return;
  await openProjectAt(selection);
}

/** Open the project at the given path and record it in the recent projects. */
export async function openProjectAt(root: string): Promise<void> {
  const store = useCodeStore.getState();
  await store.openProject(root);
  const app = useAppStore.getState();
  const recent = [root, ...app.recentCodeProjects.filter((p) => p !== root)].slice(0, 10);
  app.setRecentCodeProjects(recent);
  // The project is the middle column of the study mode: switching to it makes
  // the middle column show it (and enters study mode if it is not open).
  const title = root.split("/").pop() ?? root;
  app.setStudyMode(true);
  app.setStudyContent({ kind: "code", path: root, title });
  app.recordStudyCode({ path: root, title });
}

export const codeCommandDefs: CommandDef[] = [
  {
    id: "code.open-project",
    title: "打开代码项目…",
    category: "代码",
    run: () => {
      void openProjectDialog();
    },
  },
  {
    id: "code.lsp-restart",
    title: "重启代码项目的语言服务器",
    category: "代码",
    when: hasProject,
    run: () => {
      const store = useCodeStore.getState();
      const root = store.project?.root;
      if (!root) return;
      void import("./api")
        .then(({ codeApi }) => codeApi.lspStop(root))
        .then(() => {
          // Clear the "tried and failed" bookkeeping so the next file open
          // tries again.
          for (const language of Object.keys(useCodeStore.getState().lspStates)) {
            useCodeStore.getState().setLspState(language, "");
          }
        });
    },
  },
  {
    id: "code.close-project",
    title: "关闭代码项目",
    category: "代码",
    when: hasProject,
    run: () => {
      void useCodeStore.getState().closeProject();
    },
  },
  {
    id: "code.toggle-tree",
    title: "显示/隐藏文件树",
    category: "代码",
    when: hasProject,
    run: () => {
      const store = useCodeStore.getState();
      store.setTreeOpen(!store.treeOpen);
    },
  },
  {
    id: "code.focus-tree",
    title: "聚焦文件树",
    category: "代码",
    when: hasProject,
    run: () => {
      const store = useCodeStore.getState();
      // Open the drawer first if it is closed: the focus target lives in the
      // tree, not in the void.
      store.setTreeOpen(true);
      // With an open file, expand to it (in a virtual scroll that row has to
      // become a visible row before it can be focused); without one, land on
      // the first row.
      const path = store.activePath;
      if (path) store.expandTo(path);
      store.requestTreeFocus(path);
    },
  },
  {
    id: "code.toggle-problems",
    title: "显示/隐藏问题面板",
    category: "代码",
    when: hasProject,
    run: () => {
      const store = useCodeStore.getState();
      store.setProblemsOpen(!store.problemsOpen);
    },
  },
  {
    id: "code.toggle-terminal",
    title: "显示/隐藏终端",
    category: "代码",
    when: hasProject,
    run: () => {
      const store = useCodeStore.getState();
      store.setTermOpen(!store.termOpen);
    },
  },
  {
    id: "code.new-terminal",
    title: "新建终端",
    category: "代码",
    when: hasProject,
    run: () => {
      void useCodeStore.getState().spawnTerminal();
    },
  },
  {
    id: "code.go-to-definition",
    title: "跳转到定义",
    category: "代码",
    when: hasEditor,
    run: () => {
      void gotoDefinition("textDocument/definition");
    },
  },
  {
    id: "code.go-to-type-definition",
    title: "跳转到类型定义",
    category: "代码",
    when: hasEditor,
    run: () => {
      void gotoDefinition("textDocument/typeDefinition");
    },
  },
  {
    id: "code.go-to-implementation",
    title: "跳转到实现",
    category: "代码",
    when: hasEditor,
    run: () => {
      void gotoDefinition("textDocument/implementation");
    },
  },
  {
    id: "code.find-references",
    title: "查找引用",
    category: "代码",
    when: hasEditor,
    run: () => {
      void findReferences();
    },
  },
  {
    id: "code.rename-symbol",
    title: "重命名符号…",
    category: "代码",
    when: hasEditor,
    run: () => {
      requestCodeUi({ kind: "rename" });
    },
  },
  {
    id: "code.trigger-completion",
    title: "触发代码提示",
    category: "代码",
    when: hasEditor,
    run: triggerCompletion,
  },
  {
    id: "code.quick-open",
    title: "快速打开文件",
    category: "代码",
    when: hasProject,
    run: () => {
      requestCodeUi({ kind: "quick-open" });
    },
  },
  {
    id: "code.find-in-files",
    title: "在项目中查找",
    category: "代码",
    when: hasProject,
    run: () => {
      requestCodeUi({ kind: "find-in-files" });
    },
  },
  {
    id: "code.save-file",
    title: "保存文件",
    category: "代码",
    when: hasEditor,
    run: () => {
      const path = activePath();
      if (path) void useCodeStore.getState().saveFile(path);
    },
  },
  {
    id: "code.close-tab",
    title: "关闭当前标签",
    category: "代码",
    when: hasEditor,
    run: () => {
      const path = activePath();
      if (path) useCodeStore.getState().closeTab(path);
    },
  },
  {
    id: "code.next-tab",
    title: "下一个标签",
    category: "代码",
    when: hasProject,
    run: () => cycleTab(1),
  },
  {
    id: "code.prev-tab",
    title: "上一个标签",
    category: "代码",
    when: hasProject,
    run: () => cycleTab(-1),
  },
  {
    id: "code.next-problem",
    title: "下一个问题",
    category: "代码",
    when: hasProject,
    run: () => cycleProblem(1),
  },
  {
    id: "code.prev-problem",
    title: "上一个问题",
    category: "代码",
    when: hasProject,
    run: () => cycleProblem(-1),
  },
  {
    id: "code.git-diff",
    title: "查看当前文件的差异",
    category: "代码",
    when: hasEditor,
    run: () => {
      const path = activePath();
      if (path) useCodeStore.getState().setDiff(path);
    },
  },
  {
    id: "code.git-stage",
    title: "暂存当前文件",
    category: "代码",
    when: hasEditor,
    run: () => {
      const path = activePath();
      if (!path) return;
      void import("./api")
        .then(({ codeApi }) => codeApi.gitStage(useCodeStore.getState().project?.root ?? "", path))
        .then(() => useCodeStore.getState().refreshGit());
    },
  },
  {
    id: "code.git-unstage",
    title: "取消暂存当前文件",
    category: "代码",
    when: hasEditor,
    run: () => {
      const path = activePath();
      if (!path) return;
      void import("./api")
        .then(({ codeApi }) => codeApi.gitUnstage(useCodeStore.getState().project?.root ?? "", path))
        .then(() => useCodeStore.getState().refreshGit());
    },
  },
  {
    id: "code.toggle-vim",
    title: "切换代码编辑器的 vim 模式",
    category: "代码",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ codeVim: !settings.codeVim });
    },
  },
  {
    id: "code.toggle-wrap",
    title: "切换代码折行",
    category: "代码",
    run: () => {
      const { settings, patchSettings } = useAppStore.getState();
      patchSettings({ codeWrap: !settings.codeWrap });
    },
  },
];

/** The confirm action of the rename dialog (called by the panel). */
export async function confirmRename(newName: string): Promise<boolean> {
  return renameSymbol(newName);
}
