import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * Gate for the wiring of session restore / fork / titles.
 *
 * What is locked here are the "who calls whom" constraints that the compiler
 * cannot see:
 * - The restore after a restart must go through the session family (root =
 *   main session), it must not fall back to "mount only the most recently
 *   updated one".
 * - Switching to a session of the family that has not been started yet must
 *   lazy-start it instead of a bare setActiveKey.
 * - A fork must write the parent/child relation into the record file (the
 *   only way to restore it after a restart).
 * - The title must come from the session's own first message, and is
 *   requested once and written back to the file.
 *
 * The pure logic (sessionTree / sessionTitle / transcript) has its own unit
 * tests; this file only guarantees that AgentPanel is really wired along
 * that path.
 */

const raw = readFileSync("src/components/AgentPanel.tsx", "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("restart restore: the session family, not the most recent one", () => {
  it("lifecycle restore calls restoreFamily(..., \"root\")", () => {
    expect(code).toMatch(/restoreFamily\(sessions\[0\]\.id,\s*sessions,\s*"root"\)/);
  });

  it("there is no longer an openSavedSession path that mounts a single session", () => {
    expect(code).not.toMatch(/openSavedSession/);
    const fn = code.slice(code.indexOf("const restoreFamily = useCallback"));
    const body = fn.slice(0, fn.indexOf("const activateConv"));
    // A family restore must replace the whole table; a single setConvs([conv]) is only allowed in "create a new main session".
    expect(body).toMatch(/setConvs\(convs\)/);
    expect(body).not.toMatch(/setConvs\(\[conv\]\)/);
  });

  it("only the landing session is started (the backend session is single-flight, two at once would invalidate each other)", () => {
    const body = code.slice(code.indexOf("const restoreFamily = useCallback"));
    const fn = body.slice(0, body.indexOf("const activateConv"));
    expect(fn).toMatch(/const focusKey = activate === "anchor"/);
    expect(fn).toMatch(/launchRestored\(focus, token\)/);
    // Only one launchRestored call is allowed (the root and the anchor do not each start one).
    expect(fn.match(/launchRestored\(/g)?.length ?? 0).toBe(1);
  });

  it("family members map from parent back to the in-memory key (after a restart parent is a file id)", () => {
    expect(code).toMatch(/parent: member\.parent \? \(keyByFile\.get\(member\.parent\) \?\? null\)/);
  });
});

describe("session switch: lazy start", () => {
  it("both the header selection and the back action go through activateConv", () => {
    expect(code).toMatch(/onSelect=\{activateConv\}/);
    expect(code).toMatch(/onBack=\{\(\) => parentConv && activateConv\(parentConv\.key\)\}/);
  });

  it("activateConv reads from disk and starts the backend session for a session that is not started yet", () => {
    const body = code.slice(code.indexOf("const activateConv = useCallback"));
    const fn = body.slice(0, body.indexOf("const generateTitle"));
    expect(fn).toMatch(/conv\.sessionId \|\| !conv\.transcriptPath/);
    expect(fn).toMatch(/lazyStartingRef\.current\.has\(key\)/);
    expect(fn).toMatch(/launchRestored\(conv, restoreTokenRef\.current\)/);
  });

  it("the ⌘⇧Y switch and the command palette back both go through activateConv (no bare setActiveKey anymore)", () => {
    const start = code.indexOf("if (agentSwitchSignal === 0) return;");
    const switchEffect = code.slice(start, code.indexOf("}, [agentSwitchSignal", start));
    expect(switchEffect).toMatch(/activateConv\(next\)/);
    expect(switchEffect).not.toMatch(/setActiveKey/);
  });

  it("restore generation guard: the result is dropped when the token changed while reading from disk", () => {
    const fn = code.slice(code.indexOf("const launchRestored = useCallback"));
    expect(fn.slice(0, fn.indexOf("const restoreFamily"))).toMatch(
      /if \(restoreTokenRef\.current !== token\) return;/,
    );
  });
});

describe("fork: the parent/child relation is written to disk", () => {
  it("the new session's Conv records forkAt and the title source", () => {
    const fn = code.slice(code.indexOf("const forkFrom = useCallback"));
    const body = fn.slice(0, fn.indexOf("const parentConv"));
    expect(body).toMatch(/forkAt: prefix\.length/);
    expect(body).toMatch(/titleSource: "first-message"/);
  });

  it("startSession receives forkMeta: parent session file id, source summary, prefix count", () => {
    const fn = code.slice(code.indexOf("const forkFrom = useCallback"));
    const body = fn.slice(0, fn.indexOf("const parentConv"));
    expect(body).toMatch(/forkMeta: \{[\s\S]*parent: src\.sessionFileId/);
    expect(body).toMatch(/basedOn: conv\.basedOn/);
    expect(body).toMatch(/forkAt: prefix\.length/);
  });

  it("the fork passes forkMeta to buildSessionMeta when writing to disk", () => {
    expect(code).toMatch(/parent: opts\.forkMeta\?\.parent \?\? null/);
    expect(code).toMatch(/basedOn: opts\.forkMeta\?\.basedOn/);
    expect(code).toMatch(/forkAt: opts\.forkMeta\?\.forkAt/);
  });
});

describe("title: the session's own first message, generated once by the model and written to disk", () => {
  it("the seed is recorded on the first send, and a session already named by the LLM is not recorded again", () => {
    expect(code).toMatch(
      /conv\.titleSource !== "llm" && !titleSeedRef\.current\.has\(conv\.key\)/,
    );
    expect(code).toMatch(/titleSeedRef\.current\.set\(conv\.key,/);
  });

  it("it fires after a successful turn_end, and the seed is deleted once it is used", () => {
    const turnEnd = code.slice(code.indexOf('case "turn_end"'));
    const body = turnEnd.slice(0, turnEnd.indexOf('case "error"'));
    expect(body).toMatch(/titleSeedRef\.current\.get\(conv\.key\)/);
    expect(body).toMatch(/titleSeedRef\.current\.delete\(conv\.key\)/);
    expect(body).toMatch(/generateTitle\(conv\.key, seed\)/);
  });

  it("a failed turn does not trigger it (the local fallback title is kept)", () => {
    const errCase = code.slice(code.indexOf('case "error"'));
    const body = errCase.slice(0, errCase.indexOf("requestAnimationFrame"));
    expect(body).not.toMatch(/generateTitle/);
  });

  it("the model is asked only once; the title goes from cleaning to the hierarchy prefix and back into the file", () => {
    const fn = code.slice(code.indexOf("const generateTitle = useCallback"));
    const body = fn.slice(0, fn.indexOf("// 主会话生命周期"));
    expect(body).toMatch(/titleAskedRef\.current\.has\(convKey\)/);
    expect(body).toMatch(/titleAskedRef\.current\.add\(convKey\)/);
    expect(body).toMatch(/cleanGeneratedTitle\(raw\)/);
    expect(body).toMatch(/displayTitle\(clean, conv\.parent !== null\)/);
    expect(body).toMatch(/setSessionTitle\(relDir, conv\.sessionFileId, label\)/);
    // The title uses the session's own model snapshot, the same one the conversation uses.
    expect(body).toMatch(/generateTitle\(seed, conv\.model \?\? undefined\)/);
  });

  it("a restored LLM title is not generated again", () => {
    const fn = code.slice(code.indexOf("const launchRestored = useCallback"));
    const body = fn.slice(0, fn.indexOf("const restoreFamily"));
    expect(body).toMatch(/titleSource: sessionMeta\?\.titleSource === "llm" \? "llm" : "first-message"/);
  });
});
