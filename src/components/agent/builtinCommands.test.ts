import { describe, expect, it, vi } from "vitest";
import type { Conv } from "@/components/agent/model";
import { parseBuiltinCommand, runBuiltinCommand, type BuiltinContext } from "./builtinCommands";

/**
 * Built-in `/` commands are panel actions that never reach the model. The
 * parser is deliberately exact: `/compact now` is a normal message, not a
 * command with an argument, and any other `/name` belongs to skills.
 */

function conv(key: string, sessionId: string | null): Conv {
  // The built-ins read only these two fields; the rest of the conversation
  // model is irrelevant and is not constructed for this unit.
  return { key, sessionId } as unknown as Conv;
}

function context() {
  const calls: string[] = [];
  const compact = vi.fn(async (sessionId: string) => {
    calls.push(`compact:${sessionId}`);
  });
  const newSession = vi.fn(() => {
    calls.push("newSession");
  });
  const notice = vi.fn((key: string, _text: string) => {
    calls.push(`notice:${key}`);
  });
  const ctx: BuiltinContext = { compact, newSession, notice };
  return { ctx, calls, compact, newSession, notice };
}

describe("parseBuiltinCommand", () => {
  it("recognizes exactly the three built-ins", () => {
    expect(parseBuiltinCommand("/compact")).toBe("compact");
    expect(parseBuiltinCommand("/clear")).toBe("clear");
    expect(parseBuiltinCommand("/help")).toBe("help");
  });

  it("leaves anything with extra text, a different case or no slash to the model", () => {
    for (const text of [
      "/compact now",
      "/compact ",
      "/clear\n",
      "/help me",
      "/Compact",
      "compact",
      " /help",
      "/restart",
      "",
    ]) {
      expect(parseBuiltinCommand(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("runBuiltinCommand", () => {
  it("compacts the current session by id", async () => {
    const { ctx, calls, compact } = context();
    await runBuiltinCommand("compact", conv("main", "session-1"), ctx);
    expect(compact).toHaveBeenCalledWith("session-1");
    expect(calls).toEqual(["compact:session-1"]);
  });

  it("does nothing on compact when the session has not started", async () => {
    const { ctx, compact } = context();
    await runBuiltinCommand("compact", conv("main", null), ctx);
    await runBuiltinCommand("compact", null, ctx);
    expect(compact).not.toHaveBeenCalled();
  });

  it("clear starts a new session", async () => {
    const { ctx, calls, compact, newSession } = context();
    await runBuiltinCommand("clear", conv("main", "s"), ctx);
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
    expect(calls).toEqual(["newSession"]);
  });

  it("help appends the command list to the current conversation", async () => {
    const { ctx, notice } = context();
    await runBuiltinCommand("help", conv("session-key", "s"), ctx);
    expect(notice).toHaveBeenCalledTimes(1);
    const [key, text] = notice.mock.calls[0] ?? ["", ""];
    expect(key).toBe("session-key");
    expect(text).toContain("/compact");
    expect(text).toContain("/clear");
    expect(text).toContain("/help");
  });

  it("help without a conversation still explains the commands", async () => {
    const { ctx, notice } = context();
    await runBuiltinCommand("help", null, ctx);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toBe("");
  });

  it("ignores an unknown name without touching the context", async () => {
    const { ctx, calls } = context();
    await runBuiltinCommand("restart", conv("main", "s"), ctx);
    expect(calls).toEqual([]);
  });
});
