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
 * 代码项目的命令。
 *
 * 全部归 **code 区域**(见 `src/commands/keys.ts` 的区域模型):焦点在代码
 * 编辑器里时生效,笔记区 / 阅读区 / Agent 面板的键位不会渗进来,反之亦然。
 * 这就是「代码编辑器中的快捷键要和其他的分开」的那条分界线。
 *
 * 命令本身可以在 `<vault>/.bnote/keybindings.json` 的 `code` 段里改绑:
 *
 * ```json
 * { "code": { "code.go-to-definition": "F12" } }
 * ```
 */

/** 项目开着没(命令的 when 用)。 */
function hasProject(): boolean {
  return useCodeStore.getState().project !== null;
}

/** 有打开的代码编辑器没。 */
function hasEditor(): boolean {
  return activeCodeEditor() !== null;
}

/** 当前文件路径(没有就 null)。 */
function activePath(): string | null {
  return useCodeStore.getState().activePath;
}

/** 触发补全面板。 */
function triggerCompletion(): void {
  const handle = activeCodeEditor();
  if (!handle) return;
  startCompletion(handle.view);
  handle.view.focus();
}

/** 选下一个/上一个标签页。 */
function cycleTab(dir: 1 | -1): void {
  const store = useCodeStore.getState();
  const { tabs, activePath: current } = store;
  if (tabs.length < 2) return;
  const index = current ? tabs.indexOf(current) : -1;
  const next = tabs[(index + dir + tabs.length) % tabs.length];
  store.setActiveTab(next);
}

/** 跳到下一个/上一个问题(诊断)。 */
function cycleProblem(direction: 1 | -1): void {
  const store = useCodeStore.getState();
  const problems: ProblemTarget[] = Object.entries(store.diagnostics).flatMap(([path, list]) =>
    list.map((d) => ({ path, position: d.range.start })),
  );
  // 游标是**光标**的位置,不是「当前文件的第 0 条诊断」:后者会让同一文件
  // 里的第二条问题永远轮不到(见 problems.ts 的说明)。
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

/** 打开一个项目(原生目录选择框)。 */
export async function openProjectDialog(): Promise<void> {
  const selection = await openFileDialog({
    directory: true,
    title: "选择代码项目文件夹",
  });
  if (typeof selection !== "string") return;
  await openProjectAt(selection);
}

/** 打开指定路径的项目,并记进「最近项目」。 */
export async function openProjectAt(root: string): Promise<void> {
  const store = useCodeStore.getState();
  await store.openProject(root);
  const app = useAppStore.getState();
  const recent = [root, ...app.recentCodeProjects.filter((p) => p !== root)].slice(0, 10);
  app.setRecentCodeProjects(recent);
  // 项目是学习模式的中栏内容:切过去,中栏就显示它(不在学习模式就先进去)。
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
          // 清掉「起过没起来」的记账,下一次打开文件会重新试。
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

/** 重命名对话框的确认动作(由面板调用)。 */
export async function confirmRename(newName: string): Promise<boolean> {
  return renameSymbol(newName);
}
