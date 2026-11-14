import { describe, expect, it } from "vitest";
import { codeSessionIdentity, codeSessionPath } from "./sessionScope";

/**
 * A coding session belongs to the repository, not to the notebook: its record
 * lives under the agent home keyed by the project root. The identity is what
 * restores a session family when the same project is re-entered, so it must be
 * stable and must not collide two different roots — including "no project".
 */
describe("codeSessionIdentity", () => {
  it("is keyed by the project root", () => {
    expect(codeSessionIdentity("/Users/me/repo")).toBe("code|/Users/me/repo");
  });

  it("two different roots never share an identity", () => {
    expect(codeSessionIdentity("/a/repo")).not.toBe(codeSessionIdentity("/b/repo"));
    expect(codeSessionIdentity("/a/repo/")).not.toBe(codeSessionIdentity("/a/repo"));
  });

  it("no project has its own identity instead of an empty tail", () => {
    expect(codeSessionIdentity(null)).toBe("code|none");
  });
});

describe("codeSessionPath", () => {
  it("joins the home directory and the session id", () => {
    expect(codeSessionPath("/agent/home", "s1")).toBe("/agent/home/s1.jsonl");
  });

  it("a trailing slash on the home directory does not double the separator", () => {
    expect(codeSessionPath("/agent/home/", "s1")).toBe("/agent/home/s1.jsonl");
  });

  it("an unresolved home directory has no path (the caller must not invent one)", () => {
    expect(codeSessionPath(null, "s1")).toBeNull();
  });
});
