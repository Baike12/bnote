import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fenceStateScan } from "./context";
import { calloutRegions } from "./callout";

/**
 * Hierarchical heading numbering: every ATX heading outside code gets a
 * `1.1.2`-style number based on document order (`##` after the first `#`
 * becomes `1.1`, the next `#` resets `##` to `2.1`, …). Existing number
 * prefixes are replaced, so toggling headings keeps the whole document
 * consistent. Replacement only touches the `## old-number` prefix, so the
 * cursor inside the title text maps through unchanged.
 *
 * Heading collection is a plain line scan, not a syntax-tree walk: right
 * after a file switch the tree is still unparsed and a tree query silently
 * misses headings (partial numbering that then sticks). A scan is complete
 * and deterministic at any time; fenced code is excluded by tracking ```
 * / ~~~ toggles (fences indented deeper than 3 spaces — inside nested list
 * items — are only recognized by the tree, which is fine since the scan is
 * only ever a fallback-grade approximation of the same rule).
 *
 * Callout 块(`:::` 容器)是独立的编号作用域:**每个区域**进栈时把外部计数器
 * 入栈并清零,出栈时原样恢复——块内标题从 1 重新数,块外序列像块内不存在一样
 * 继续。兄弟块(先后两个平级 callout)不共享计数器,各自从 1;嵌套块逐层
 * 入栈,内层再从头数。作用域按「区域身份路径」(外层→内层的区域链)对齐,
 * 不按深度数值——深度相同的两个兄弟块也是不同作用域。
 */

const OLD_NUMBER_RE = /^\d+(\.\d+)*[ \t]+/;
const HEADING_RE = /^(#{1,6})([ \t]+.*)?$/;

/** Renumber replacements for `state`, [] when the numbering is already up
 *  to date. Each change rewrites one heading's prefix up to the title text.
 *  导出供单测锁作用域语义(纯函数,无视图依赖)。 */
export function renumberChanges(state: EditorState): { from: number; to: number; insert: string }[] {
  const doc = state.doc;
  const fences = fenceStateScan(doc);
  const regions = calloutRegions(state);
  // 每个区域的最小包络父区域(区域按 from 升序且正确嵌套;从右往左找第一个
  // 装住自己的,就是最内层父区域)。
  const parent = new Array<number>(regions.length).fill(-1);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (
        regions[j].openLine <= regions[i].openLine &&
        regions[i].closeLine <= regions[j].closeLine
      ) {
        parent[i] = j;
        break;
      }
    }
  }
  /** 标题所在的作用域路径:外层→内层的区域下标链。 */
  const pathOf = (lineNo: number): number[] => {
    let idx = -1;
    for (let i = regions.length - 1; i >= 0; i--) {
      if (regions[i].openLine <= lineNo && lineNo <= regions[i].closeLine) {
        idx = i;
        break;
      }
    }
    const path: number[] = [];
    for (let r = idx; r !== -1; r = parent[r]) path.unshift(r);
    return path;
  };

  const heads: { lineNo: number; level: number }[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    if (fences[n - 1]) continue;
    // Only headings that own their whole line from column 0 (not
    // list-embedded, matching the previous tree-based rule).
    const m = HEADING_RE.exec(doc.line(n).text);
    if (m) heads.push({ lineNo: n, level: m[1].length });
  }
  if (heads.length === 0) return [];

  const counters = [0, 0, 0, 0, 0, 0, 0];
  const saved: number[][] = [];
  let prevPath: number[] = [];
  let curDepth = 0;
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const head of heads) {
    // Callout 作用域进出:与上一个标题的作用域路径求公共前缀,弹出的层恢复
    // 计数器,新进的层清零。深度可能一跳多层(嵌套块里第一个标题),循环补齐。
    const path = pathOf(head.lineNo);
    let common = 0;
    while (
      common < path.length &&
      common < prevPath.length &&
      path[common] === prevPath[common]
    ) {
      common++;
    }
    while (curDepth > common) {
      const outer = saved.pop();
      if (outer) counters.splice(0, outer.length, ...outer);
      curDepth--;
    }
    while (curDepth < path.length) {
      saved.push(counters.slice());
      counters.fill(0);
      curDepth++;
    }
    prevPath = path;
    counters[head.level]++;
    for (let l = head.level + 1; l <= 6; l++) counters[l] = 0;
    // Strict level counters, then drop missing-parent (leading zero) parts so
    // a document starting at `##` numbers it "1" rather than "0.1".
    const parts = counters.slice(1, head.level + 1);
    while (parts.length > 1 && parts[0] === 0) parts.shift();
    const number = parts.join(".");

    const line = doc.line(head.lineNo);
    const hash = "#".repeat(head.level);
    const rest = line.text.slice(head.level).replace(/^[ \t]+/, "");
    const title = rest.replace(OLD_NUMBER_RE, "");
    const titleStart = line.to - title.length;
    const want = title ? `${hash} ${number} ` : `${hash} ${number}`;
    const have = line.text.slice(0, line.text.length - title.length);
    if (have !== want) {
      changes.push({ from: line.from, to: titleStart, insert: want });
    }
  }
  return changes;
}

/** Runs one renumbering pass over the current document (no-op when current
 *  numbers are already correct). The cursor maps through prefix-only edits. */
export function renumberHeadings(view: EditorView) {
  const changes = renumberChanges(view.state);
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.bnote-renumber" });
  }
}
