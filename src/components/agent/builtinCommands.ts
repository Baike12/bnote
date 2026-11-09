/**
 * The built-in `/` commands (Claude Code's LocalCommand subset): panel actions
 * that never reach the model. The command set lives here so the parser and the
 * dispatch cannot disagree about it; the panel supplies what each one does.
 */

import type { Conv } from "@/components/agent/model";

const BUILTIN_PATTERN = /^\/(compact|clear|help)$/;

/** The built-in name of an exact `/name` prompt, or null when it is a normal message. */
export function parseBuiltinCommand(text: string): string | null {
  return BUILTIN_PATTERN.exec(text)?.[1] ?? null;
}

export interface BuiltinContext {
  /** Compress the session's context (the panel owns the busy state around it). */
  compact(sessionId: string): Promise<void>;
  /** Open a new session. */
  newSession(): void;
  /** Append a display-only line to the conversation. */
  notice(convKey: string, text: string): void;
}

export async function runBuiltinCommand(
  name: string,
  conv: Conv | null,
  ctx: BuiltinContext,
): Promise<void> {
  switch (name) {
    case "compact": {
      const sid = conv?.sessionId;
      if (sid) await ctx.compact(sid);
      return;
    }
    case "clear":
      ctx.newSession();
      return;
    case "help":
      ctx.notice(
        conv?.key ?? "",
        [
          "可用命令:/compact 压缩上下文 · /clear 新会话 · /help 本说明",
          "技能:输入 / 加名称加载其指导;文件引用:输入 @ 加路径,内容会随消息附上。",
        ].join("\n"),
      );
      return;
    default:
      return;
  }
}
