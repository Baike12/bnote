/**
 * 分钟输入框的草稿解析。
 *
 * 为什么不能边打字边提交:清空输入框时 `Number("")` 是 0,归一化会把它夹成
 * 1,于是用户永远删不掉那个数字(想输 25 就没法先把 1 删掉)。这里把"草稿"
 * 和"提交值"分开:空串/非法输入一律返回 null(保留原值),只有合法数字才落库。
 *
 * 返回 null = 这次输入不构成有效时长,调用方应把输入框还原成当前值。
 */
export function parseMinutesDraft(
  draft: string,
  { min = 1, max = 180 }: { min?: number; max?: number } = {},
): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
