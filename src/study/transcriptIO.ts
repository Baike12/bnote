import { api, homeApi } from "@/lib/tauri";

/**
 * Where a session transcript lives.
 *
 * Study and creative sessions belong to their material, so the record sits
 * inside the vault (`<vault>/.bnote/materials/.../sessions/`). A coding session
 * belongs to the agent, not to the notebook: its record sits in the agent home
 * (`~/.bnote/projects/<project>/<session>.jsonl`), exactly like Claude Code's
 * transcripts under `~/.claude/projects/`.
 *
 * The two stores have different IPC commands (the vault commands are confined
 * to the vault, the home commands to `~/.bnote`), so the caller picks the pair
 * once per conversation instead of guessing from the path.
 */
export interface TranscriptIO {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  append(path: string, contents: string): Promise<void>;
}

export const vaultTranscriptIO: TranscriptIO = {
  read: (path) => api.readFile(path),
  write: (path, contents) => api.writeFile(path, contents),
  append: (path, contents) => api.appendFile(path, contents),
};

export const homeTranscriptIO: TranscriptIO = {
  read: (path) => homeApi.readFile(path),
  write: (path, contents) => homeApi.writeFile(path, contents),
  append: (path, contents) => homeApi.appendFile(path, contents),
};

export function transcriptIO(home: boolean): TranscriptIO {
  return home ? homeTranscriptIO : vaultTranscriptIO;
}
