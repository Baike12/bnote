import { describe, expect, it } from "vitest";
import { newTurn, type ChatEntry } from "./model";
import { lastUserEntryIndex, rewindKeep, rewindPrefix } from "./editResend";

/**
 * "Edit and resend" removes one branch of the conversation: the rules must
 * name exactly the last user message (an older one would take every later turn
 * with it) and count the record position the marker has to repeat.
 */

function user(text: string): ChatEntry {
  return { role: "user", text, at: 1, items: null };
}

function answer(text: string): ChatEntry {
  return { role: "assistant", text, at: 2, items: null, turn: { ...newTurn(null), text } };
}

describe("the editable message is the last user message", () => {
  it("finds it through the assistant rows that follow it", () => {
    const entries = [user("第一问"), answer("第一答"), user("第二问"), answer("第二答")];
    expect(lastUserEntryIndex(entries)).toBe(2);
  });

  it("a conversation with no user message offers nothing", () => {
    expect(lastUserEntryIndex([])).toBeNull();
    expect(lastUserEntryIndex([answer("欢迎语")])).toBeNull();
  });

  it("status lines after it do not hide it", () => {
    const entries = [
      user("问"),
      answer("答"),
      { role: "notice" as const, text: "x", at: 3, items: null },
    ];
    expect(lastUserEntryIndex(entries)).toBe(0);
  });
});

describe("the rewind keeps everything before the edited message", () => {
  it("drops the edited message and the turn it produced", () => {
    const entries = [user("第一问"), answer("第一答"), user("第二问(要改)"), answer("半截")];
    const prefix = rewindPrefix(entries, 2);
    expect(prefix.map((e) => e.text)).toEqual(["第一问", "第一答"]);
    // The surviving entries are the very objects: the rewind removes the tail,
    // it does not rewrite what came before.
    expect(prefix[1]).toBe(entries[1]);
  });

  it("editing the first message keeps nothing", () => {
    expect(rewindPrefix([user("唯一一问"), answer("答")], 0)).toEqual([]);
  });

  it("the marker counts record lines, not entries (a turn is one line per round)", () => {
    const multiRound: ChatEntry = {
      role: "assistant",
      text: "第一轮文本第二轮文本",
      at: 2,
      items: null,
      turn: {
        ...newTurn(null),
        text: "第一轮文本第二轮文本",
        steps: [
          { kind: "text", start: 0, end: 5 },
          { kind: "tool", id: "t1" },
          { kind: "text", start: 5, end: 10 },
        ],
        tools: [{ id: "t1", name: "Read", input: {}, output: "x", ok: true }],
      },
    };
    const prefix = [user("问"), multiRound];
    // Two rounds flushed two record lines, plus the user line.
    expect(rewindKeep(prefix)).toBe(3);
    expect(rewindKeep([])).toBe(0);
  });
});
