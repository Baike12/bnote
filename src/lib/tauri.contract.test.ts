import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The typed IPC boundary (`src/lib/tauri.ts`) is the only place the frontend
 * spells a Rust command name. A typo, a renamed command, or a payload field
 * dropped during a refactor still typechecks — nothing on either side of the
 * `invoke()` call sees the other. This test executes every exported wrapper
 * against a recording `invoke` and pins the command map, so a wrapper that
 * disappears, calls nothing, or changes its command name fails here.
 *
 * Payload shapes are pinned for the boundaries whose fields are easy to get
 * wrong (file IO, agent turns, permissions, focus, home history).
 */

const invokeMock = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown) => null));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { agentApi, api, bblogApi, focusApi, homeApi, translateApi } from "./tauri";

type Calls = Record<string, string>;

interface Boundary {
  group: string;
  method: string;
  run: (...args: unknown[]) => unknown;
}

function boundaries(): Boundary[] {
  const out: Boundary[] = [];
  const groups: Record<string, object> = {
    api,
    agentApi,
    bblogApi,
    focusApi,
    homeApi,
    translateApi,
  };
  for (const [group, object] of Object.entries(groups)) {
    for (const [method, value] of Object.entries(object)) {
      if (typeof value !== "function") continue;
      out.push({ group, method, run: value as (...args: unknown[]) => unknown });
    }
  }
  return out;
}

/** Call every wrapper with the number of arguments it declares; the values are irrelevant to `invoke`. */
function dummyArgs(fn: (...args: unknown[]) => unknown): unknown[] {
  return Array.from({ length: fn.length }, () => "x");
}

async function callBoundaries(): Promise<Calls> {
  const calls: Calls = {};
  for (const boundary of boundaries()) {
    invokeMock.mockClear();
    await boundary.run(...dummyArgs(boundary.run));
    const key = `${boundary.group}.${boundary.method}`;
    expect(invokeMock, `${key} must reach invoke exactly once`).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(typeof command, `${key} must pass a command name`).toBe("string");
    expect(command.length, `${key} must pass a non-empty command name`).toBeGreaterThan(0);
    // A command never reaches the backend with a null payload unless it has no
    // arguments at all; an argument-less command passes undefined.
    if (payload !== undefined) expect(payload).not.toBeNull();
    calls[key] = command;
  }
  return calls;
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe("every exported IPC wrapper reaches exactly one Rust command", () => {
  it("the sweep sees the whole boundary", () => {
    const list = boundaries();
    expect(list.length).toBeGreaterThan(80);
    expect(new Set(list.map((b) => `${b.group}.${b.method}`)).size).toBe(list.length);
  });

  it("command names stay stable", async () => {
    await expect(callBoundaries()).resolves.toMatchSnapshot();
  });
});

describe("payload fields keep the names the Rust commands deserialize", () => {
  it("file IO", async () => {
    await api.writeFile("/vault/note.md", "hello");
    expect(invokeMock).toHaveBeenLastCalledWith("write_file", {
      path: "/vault/note.md",
      contents: "hello",
    });

    await api.pythonSetProjectConfig("/vault/note.md", { lsp: "ty", python: "python3" });
    expect(invokeMock).toHaveBeenLastCalledWith("python_set_project_config", {
      mdPath: "/vault/note.md",
      lsp: "ty",
      python: "python3",
      tyPath: null,
    });
  });

  it("an agent turn carries the tool images slot even when omitted", async () => {
    await agentApi.send("session-1", "hello");
    expect(invokeMock).toHaveBeenLastCalledWith("agent_send", {
      sessionId: "session-1",
      text: "hello",
      images: [],
    });
  });

  it("permission and question replies keep the request id", async () => {
    await agentApi.permissionReply("session-1", "request-1", true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "agent_permission_reply",
      expect.objectContaining({
        sessionId: "session-1",
        requestId: "request-1",
        allow: true,
      }),
    );

    await agentApi.questionReply("session-1", "request-2", "yes");
    expect(invokeMock).toHaveBeenLastCalledWith("agent_question_reply", {
      sessionId: "session-1",
      requestId: "request-2",
      answer: "yes",
    });
  });

  it("focus commands use the backend's snake_case fields", async () => {
    await focusApi.setHardLockActive(true);
    expect(invokeMock).toHaveBeenLastCalledWith("focus_set_hard_lock_active", { active: true });
  });

  it("home history applies its default limit", async () => {
    await homeApi.history(null);
    expect(invokeMock).toHaveBeenLastCalledWith("agent_history", {
      project: null,
      limit: 50,
    });
  });

  it("translate commands send the selection text", async () => {
    await translateApi.selection("hello");
    expect(invokeMock).toHaveBeenLastCalledWith("translate_selection", { text: "hello" });
  });
});
