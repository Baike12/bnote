import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";

/**
 * 这个编辑器当前装的是哪个文件(绝对路径,null = 空文档)。
 *
 * 图片的相对路径需要一个基准目录,而同一个页面里可以同时存在两个编辑器(学习
 * 模式的中栏与右栏各一个),`![](assets/x.svg)` 在两栏里指的是不同文件——所以基准
 * 必须跟着文档走,不能查全局的 currentFile。存在 state 里而不是按 view 记:
 * 换文件是 `setState`(字段被重建),随后用一次 effect 事务改写,顺带触发装饰重建。
 *
 * 单独一个模块是为了让 setup.ts(装扩展)和 livePreview.ts(读路径)共用,
 * 而不互相 import 成环。
 */
export const setDocPath = StateEffect.define<string | null>();

export const docPathField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDocPath)) return e.value;
    return value;
  },
});

/** 当前编辑器里那份文档的绝对路径;未打开文件时为 null。 */
export function documentPath(state: EditorState): string | null {
  return state.field(docPathField, false) ?? null;
}
