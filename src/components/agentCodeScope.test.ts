import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * Gate for the coding session scope of the agent panel.
 *
 * The compiler cannot see these constraints, and each of them was a silent
 * bug the moment it was missing:
 * - the panel decides "coding" from code mode, not from a study content;
 * - a coding session starts with the repository as its workdir (relative
 *   paths and bash anchor there) and with the record id as the task list id
 *   (so the persisted tasks continue after a restore);
 * - the session list, the transcript path and the title write go to the agent
 *   home (`~/.bnote`), never into the vault.
 */
const raw = readFileSync("src/components/AgentPanel.tsx", "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("which definition a session runs with", () => {
  it("code mode wins over creative mode", () => {
    expect(code).toMatch(/agentModeRef\.current = mode === "code" \? "coding" : creativeMode \? "creative" : "study"/);
  });

  it("there is no study-content code variant left", () => {
    expect(code).not.toMatch(/kind === "code"/);
  });
});

describe("a coding session starts against the repository", () => {
  it("passes the workdir only for coding, and the task list id on restore", () => {
    const fn = code.slice(code.indexOf("const startSession = useCallback"));
    const body = fn.slice(0, fn.indexOf("const launchRestored"));
    expect(body).toMatch(/mode === "coding" \? codeScopeRef\.current\?\.workdir : undefined/);
    expect(body).toMatch(/opts\?\.taskListId/);
  });

  it("restore hands the record id over so the task list continues", () => {
    const fn = code.slice(code.indexOf("const launchRestored = useCallback"));
    const body = fn.slice(0, fn.indexOf("const restoreFamily"));
    expect(body).toMatch(/taskListId: conv\.sessionFileId \?\? undefined/);
  });
});

describe("a coding record lives in the agent home", () => {
  it("the scope is resolved through the home workspace command", () => {
    expect(code).toMatch(/homeApi\s*\.\s*workspace\(codeProject\.path\)/);
    expect(code).toMatch(/homeApi\s*\.\s*sessionsList\(codeProject\.path\)/);
    expect(code).toMatch(/codeSessionPath\(homeDir, info\.sessionId\)/);
  });

  it("the session list and the title write use the home API when coding", () => {
    expect(code).toMatch(/homeApi\.sessionsList\(code\.workdir\)/);
    expect(code).toMatch(/homeApi\.setSessionTitle\(codeWorkdir, id, label\)/);
  });

  it("the identity is the project root", () => {
    expect(code).toMatch(/codeSessionIdentity\(codeProject\?\.path \?\? null\)/);
  });
});
