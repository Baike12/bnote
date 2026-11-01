import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { buildTree, visibleRows, type TreeNode } from "../tree";
import { useCodeStore } from "../store";
import { activeCodeEditor } from "../editor/registry";
import { FileTypeIcon, FolderTypeIcon } from "./FileIcon";

/** git 状态 → 展示用的字母。 */
const STATUS_LABEL: Record<string, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  C: "C",
  U: "U",
  "?": "?",
};

/**
 * 行高(px)。虚拟滚动的窗口按它算——**必须与 CSS 的 `.code-tree-row` 一致**,
 * 差 1px 就会越滚越偏。
 */
const ROW_HEIGHT = 22;
/** 视口上下各多渲染几行:快速滚动时不会看到空白。 */
const OVERSCAN = 12;
/** 列表上下留白(px),与 `.code-tree-window` 的 top 对应。 */
const PAD = 4;

/**
 * 文件树。
 *
 * **虚拟滚动**:文件树是唯一随仓库规模膨胀的列表(大仓库上万行),全量渲染
 * 成 DOM 是几百毫秒到几秒的开销,还会一直养着上万个按钮。这里把树拍平成
 * `visibleRows`,只渲染视口附近那几十行——滚动时换行不换节点结构。
 *
 * **键盘可达**:⌘⇧E(命令 `code.focus-tree`)把焦点交给整棵树,有打开的
 * 文件就展开到它并停在那一行;之后 ↑↓ 走行、→← 展开/收起、Enter 打开、
 * Esc 把焦点还给编辑器。
 *
 * 焦点落在**容器**上而不是行按钮上:虚拟滚动会随滚动卸载行元素,焦点挂在
 * 行上时用户滚一下(那一行移出窗口)键盘就断了;容器不参与窗口计算,始终
 * 在。行只画一圈 `is-focus` 表示键盘停在哪(与 `.is-active`「编辑器里开着
 * 谁」是两件事)。
 *
 * 用 `memo` 包起来:代码编辑器每敲一个字,面板都会重渲染一次(内容在 store
 * 里),文件树不该跟着重画——它只依赖文件列表与 git 状态,那两份引用在打字
 * 时是不变的。
 */
export const FileTree = memo(function FileTree({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const entries = useCodeStore((s) => s.project?.tree.entries ?? []);
  const git = useCodeStore((s) => s.git);
  const truncated = useCodeStore((s) => s.project?.tree.truncated ?? false);
  // 展开态放 store:默认空集(只显示顶层,不默认展开所有文件夹),关掉抽屉
  // 再打开、重扫之后都保留;换项目由 openProject 清空。
  const expandedDirs = useCodeStore((s) => s.expandedDirs);
  const toggleDir = useCodeStore((s) => s.toggleDir);
  const focusRequest = useCodeStore((s) => s.treeFocus);
  const clearTreeFocus = useCodeStore((s) => s.clearTreeFocus);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /** 键盘停在哪一行(与「编辑器里开着谁」是两件事)。 */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** 每次「请求定位」自增:同一行连按快捷键也要重新滚到可见处。 */
  const [revealTick, setRevealTick] = useState(0);

  // 视口高度随中栏拖动/窗口缩放变化:量不到高度就只能渲染十几行(空列表)。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setViewportHeight(host.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const gitMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof git>["files"][number]>();
    for (const file of git?.files ?? []) map.set(file.path, file);
    return map;
  }, [git]);

  const roots = useMemo(() => buildTree(entries, gitMap), [entries, gitMap]);
  const rows = useMemo(
    () => visibleRows(roots, expandedDirs),
    [roots, expandedDirs],
  );
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.node.path, index));
    return map;
  }, [rows]);

  // 视口窗口。滚动位置会被浏览器夹回内容高度内,但夹回是异步的(下一帧),
  // 折叠后同一帧里 scrollTop 可能已经越界——这里自己再夹一次。
  const first =
    rows.length === 0
      ? 0
      : Math.min(
          rows.length - 1,
          Math.max(0, Math.floor((scrollTop - PAD) / ROW_HEIGHT) - OVERSCAN),
        );
  const last =
    rows.length === 0
      ? 0
      : Math.min(
          rows.length,
          Math.max(0, Math.ceil((scrollTop - PAD + viewportHeight) / ROW_HEIGHT) + OVERSCAN),
        );

  /** 把键盘焦点移到某一行,并保证它滚进视口。 */
  const revealTo = useCallback((path: string) => {
    setFocusPath(path);
    setRevealTick((tick) => tick + 1);
  }, []);

  // 消费一次「聚焦文件树」请求。目标行必须是可见行的一部分:调用方
  // (code.focus-tree)已经展开过祖先目录,这里按实际行数组兜底(路径不在
  // 树上就落第一行,不把焦点留在虚空里)。
  useEffect(() => {
    if (!focusRequest) return;
    clearTreeFocus();
    const wanted = focusRequest.path;
    const target =
      wanted && rowIndex.has(wanted) ? wanted : (rows[0]?.node.path ?? null);
    if (!target) return;
    // 焦点归容器(行会随滚动卸载,容器不会);坐标由 reveal effect 自己算,
    // preventScroll 防止浏览器再滚一次把结果顶歪。
    hostRef.current?.focus({ preventScroll: true });
    revealTo(target);
  }, [focusRequest, clearTreeFocus, rowIndex, rows, revealTo]);

  // 让 focusPath 滚进视口。只滚 DOM,不搬焦点(焦点一直在容器上),所以
  // 不需要等窗口渲染出元素,也就没有「滚一次、聚焦一次」的两趟时序。
  useEffect(() => {
    if (!focusPath) return;
    const host = hostRef.current;
    if (!host) return;
    const index = rowIndex.get(focusPath);
    if (index === undefined) return;
    const top = PAD + index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
      host.scrollTop = Math.max(
        0,
        Math.round(top - (host.clientHeight - ROW_HEIGHT) / 2),
      );
      setScrollTop(host.scrollTop);
    }
  }, [focusPath, revealTick, rowIndex]);

  if (roots.length === 0) {
    return <div className="code-tree-empty">这个项目里没有文件</div>;
  }

  // 折叠会把 focusPath 指向的行收走:这时退到「编辑器里开着的文件」或
  // 第一行,键盘不会卡在一个已经看不见的路径上。
  const currentPath =
    (focusPath && rowIndex.has(focusPath) ? focusPath : null) ??
    (activePath && rowIndex.has(activePath) ? activePath : null) ??
    (rows[0]?.node.path ?? null);

  /** 焦点在相邻行之间移动(越界就停在原处)。 */
  const moveFocus = (delta: number) => {
    if (rows.length === 0 || !currentPath) return;
    const index = rowIndex.get(currentPath) ?? -1;
    const next = Math.min(rows.length - 1, Math.max(0, index + delta));
    const row = rows[next];
    if (row) revealTo(row.node.path);
  };

  /**
   * 树里的键位。焦点在容器上,按键从容器冒泡到这里(窗口级命令分发之前
   * 收到);处理过的键 preventDefault,不再触发按钮的原生行为。
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 || !currentPath) return;
    const index = rowIndex.get(currentPath);
    if (index === undefined) return;
    const row = rows[index];
    const isDir = row.node.isDir;
    const open = expandedDirs.has(row.node.path);

    switch (event.key) {
      case "ArrowDown":
        moveFocus(1);
        break;
      case "ArrowUp":
        moveFocus(-1);
        break;
      case "Home":
        revealTo(rows[0].node.path);
        break;
      case "End":
        revealTo(rows[rows.length - 1].node.path);
        break;
      case "ArrowRight":
        // 收起状态先展开;已经展开就走进第一个子节点(与文件管理器一致)。
        if (isDir && !open) toggleDir(row.node.path);
        else moveFocus(1);
        break;
      case "ArrowLeft":
        if (isDir && open) toggleDir(row.node.path);
        else {
          const slash = row.node.path.lastIndexOf("/");
          if (slash > 0) revealTo(row.node.path.slice(0, slash));
        }
        break;
      case "Enter":
      case " ":
        if (isDir) toggleDir(row.node.path);
        else onOpen(row.node.path);
        break;
      case "Escape":
        // 把键盘还给代码:浏览完文件不该再需要点一下编辑器。没有编辑器
        // (图片/二进制/差异视图)就只是放开焦点。
        {
          const handle = activeCodeEditor();
          if (handle) handle.view.focus();
          else hostRef.current?.blur();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="code-tree"
      ref={hostRef}
      tabIndex={-1}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={handleKeyDown}
    >
      <div className="code-tree-spacer" style={{ height: PAD * 2 + rows.length * ROW_HEIGHT }}>
        <div
          className="code-tree-window"
          style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
        >
          {rows.slice(first, last).map((row) => (
            <TreeRow
              key={row.node.path}
              node={row.node}
              depth={row.depth}
              expanded={expandedDirs}
              activePath={activePath}
              focusPath={focusPath}
              onToggle={toggleDir}
              onOpen={onOpen}
              onFocusRow={setFocusPath}
            />
          ))}
        </div>
      </div>
      {truncated && <div className="code-tree-note">文件太多,列表已截断</div>}
    </div>
  );
});

function TreeRow({
  node,
  depth,
  expanded,
  activePath,
  focusPath,
  onToggle,
  onOpen,
  onFocusRow,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  focusPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onFocusRow: (path: string) => void;
}) {
  const pad = { paddingLeft: `${6 + depth * 12}px` };
  const focused = focusPath === node.path;

  if (node.isDir) {
    return (
      <button
        type="button"
        className={`code-tree-row code-tree-dir${focused ? " is-focus" : ""}`}
        style={pad}
        data-path={node.path}
        onClick={() => onToggle(node.path)}
        onFocus={() => onFocusRow(node.path)}
        title={node.path}
      >
        <FolderTypeIcon open={expanded.has(node.path)} />
        <span className="code-tree-name">{node.name}</span>
      </button>
    );
  }

  const status = node.git ? STATUS_LABEL[node.git.worktree || node.git.index] : undefined;
  const staged = node.git ? node.git.index && node.git.index !== " " : false;

  return (
    <button
      type="button"
      className={`code-tree-row code-tree-file${
        activePath === node.path ? " is-active" : ""
      }${focused ? " is-focus" : ""}`}
      style={pad}
      data-path={node.path}
      onClick={() => onOpen(node.path)}
      onFocus={() => onFocusRow(node.path)}
      title={node.path}
    >
      <FileTypeIcon name={node.name} />
      <span className="code-tree-name">{node.name}</span>
      {status && (
        <span
          className={`code-tree-status${staged ? " is-staged" : ""}`}
          title={staged ? "已暂存" : "工作区有改动"}
        >
          {status}
        </span>
      )}
    </button>
  );
}
