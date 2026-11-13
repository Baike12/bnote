import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  readFile: vi.fn(async (path: string) => `vault:${path}`),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));
const homeApi = vi.hoisted(() => ({
  readFile: vi.fn(async (path: string) => `home:${path}`),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri", () => ({ api, homeApi }));

import { homeTranscriptIO, transcriptIO, vaultTranscriptIO } from "./transcriptIO";

/**
 * A transcript's store is decided once per conversation: study/creative
 * records live in the vault, coding records in the agent home. Each pair must
 * use its own IPC commands — the vault commands reject paths outside the
 * vault, the home commands reject paths outside `~/.bnote`.
 */

describe("vault transcripts", () => {
  it("routes read/write/append to the vault commands", async () => {
    await expect(vaultTranscriptIO.read("/vault/.bnote/s.jsonl")).resolves.toBe(
      "vault:/vault/.bnote/s.jsonl",
    );
    await vaultTranscriptIO.write("/vault/s.jsonl", "x");
    await vaultTranscriptIO.append("/vault/s.jsonl", "y");

    expect(api.readFile).toHaveBeenCalledWith("/vault/.bnote/s.jsonl");
    expect(api.writeFile).toHaveBeenCalledWith("/vault/s.jsonl", "x");
    expect(api.appendFile).toHaveBeenCalledWith("/vault/s.jsonl", "y");
    expect(homeApi.readFile).not.toHaveBeenCalled();
  });
});

describe("home transcripts", () => {
  it("routes read/write/append to the home commands", async () => {
    await expect(homeTranscriptIO.read("/Users/me/.bnote/projects/p/s.jsonl")).resolves.toBe(
      "home:/Users/me/.bnote/projects/p/s.jsonl",
    );
    await homeTranscriptIO.write("/Users/me/.bnote/s.jsonl", "x");
    await homeTranscriptIO.append("/Users/me/.bnote/s.jsonl", "y");

    expect(homeApi.readFile).toHaveBeenCalledWith("/Users/me/.bnote/projects/p/s.jsonl");
    expect(homeApi.writeFile).toHaveBeenCalledWith("/Users/me/.bnote/s.jsonl", "x");
    expect(homeApi.appendFile).toHaveBeenCalledWith("/Users/me/.bnote/s.jsonl", "y");
    expect(api.readFile).not.toHaveBeenCalled();
  });
});

describe("transcriptIO", () => {
  it("picks the pair from the home flag", () => {
    expect(transcriptIO(false)).toBe(vaultTranscriptIO);
    expect(transcriptIO(true)).toBe(homeTranscriptIO);
  });
});
