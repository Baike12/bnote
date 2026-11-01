/**
 * 代码面板的「一次性请求」通道。
 *
 * 命令层要能请面板做几件事(打开快速跳转框、打开文件内搜索、问一个重命名
 * 的新名字),但命令层不该直接持有面板的 DOM。做法与 bnote 其它地方一致:
 * 命令发一个请求,面板订阅并消费——**只消费一次**,不然后来者会看到上一次
 * 的残留请求。
 */

/** 面板要处理的请求。 */
export type CodeUiRequest =
  | { kind: "quick-open" }
  | { kind: "find-in-files" }
  | { kind: "rename" };

type Listener = (request: CodeUiRequest) => void;

const listeners = new Set<Listener>();

/** 请面板做一件事。 */
export function requestCodeUi(request: CodeUiRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** 订阅面板请求;返回退订函数。 */
export function onCodeUiRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
