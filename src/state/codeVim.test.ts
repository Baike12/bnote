import { describe, expect, it } from "vitest";
import { codeVimEnabled, DEFAULT_CODE_VIM, normalizeCodeVim } from "./codeVim";

describe("normalizeCodeVim: the stored value becomes a mode", () => {
  it("passes the three modes through unchanged", () => {
    expect(normalizeCodeVim("inherit")).toBe("inherit");
    expect(normalizeCodeVim("on")).toBe("on");
    expect(normalizeCodeVim("off")).toBe("off");
  });

  it("migrates a legacy boolean once: true pins on, false inherits", () => {
    // false was also the old untouched default, so it cannot be told apart
    // from a deliberate "off"; it migrates to inherit.
    expect(normalizeCodeVim(true)).toBe("on");
    expect(normalizeCodeVim(false)).toBe("inherit");
  });

  it("falls back to inherit for a missing or broken value", () => {
    expect(normalizeCodeVim(undefined)).toBe(DEFAULT_CODE_VIM);
    expect(normalizeCodeVim(null)).toBe(DEFAULT_CODE_VIM);
    expect(normalizeCodeVim("yes")).toBe(DEFAULT_CODE_VIM);
    expect(normalizeCodeVim(1)).toBe(DEFAULT_CODE_VIM);
  });

  it("is idempotent: normalizing a mode again changes nothing", () => {
    for (const mode of ["inherit", "on", "off"] as const) {
      expect(normalizeCodeVim(normalizeCodeVim(mode))).toBe(mode);
    }
  });
});

describe("codeVimEnabled: inherit follows the notes switch", () => {
  it("inherit mirrors the notes vim switch both ways", () => {
    expect(codeVimEnabled({ vim: true, codeVim: "inherit" })).toBe(true);
    expect(codeVimEnabled({ vim: false, codeVim: "inherit" })).toBe(false);
  });

  it("an explicit on / off ignores the notes switch", () => {
    expect(codeVimEnabled({ vim: false, codeVim: "on" })).toBe(true);
    expect(codeVimEnabled({ vim: true, codeVim: "off" })).toBe(false);
  });
});
