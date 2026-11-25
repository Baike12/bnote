import type { McpScope, McpServerStatus } from "@/lib/tauri";

/**
 * The pure half of the MCP settings page: parsing the scope files, computing
 * the effective list (a later scope wins a name, the disabled lists union) and
 * editing one file without touching the rest of it. The component only wires
 * these to the DOM.
 */

export type McpEntry = Record<string, unknown>;

/** A settings file as an object; a broken file is reported elsewhere, the list shows what parses. */
export function settingsObject(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object.
  }
  return {};
}

export function serversOf(file: Record<string, unknown>): Record<string, McpEntry> {
  const value = file.mcpServers;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, McpEntry>)
    : {};
}

export function disabledOf(file: Record<string, unknown>): string[] {
  return Array.isArray(file.disabledMcpServers) ? file.disabledMcpServers.map(String) : [];
}

export function mcpTransport(value: McpEntry): "stdio" | "http" {
  return value.type === "http" ? "http" : "stdio";
}

export function mcpTarget(value: McpEntry): string {
  if (typeof value.command === "string") {
    const args = Array.isArray(value.args) ? value.args.map(String) : [];
    return [value.command, ...args].join(" ");
  }
  return typeof value.url === "string" ? value.url : "(配置不完整)";
}

/**
 * The effective rows of the given scopes before a check has run. Mirrors the
 * backend merge: a later scope's definition wins a name, and a name disabled in
 * any layer is disabled (the merged list is a union).
 */
export function effectiveServers(
  files: Partial<Record<McpScope, Record<string, unknown>>>,
  scopes: McpScope[],
): McpServerStatus[] {
  const disabled = new Set(scopes.flatMap((scope) => disabledOf(files[scope] ?? {})));
  const merged = new Map<string, McpServerStatus>();
  for (const scope of scopes) {
    for (const [name, value] of Object.entries(serversOf(files[scope] ?? {}))) {
      merged.set(name, {
        name,
        scope,
        source: "",
        transport: mcpTransport(value),
        target: mcpTarget(value),
        enabled: !disabled.has(name),
        // Only the user scope runs without approval; the report says which
        // project servers were actually approved.
        trusted: scope === "user",
        state: "unknown",
        tools: 0,
        error: null,
      });
    }
  }
  return [...merged.values()];
}

/** The scopes holding `name` in their disabled list (where enabling must edit). */
export function scopesDisabling(
  files: Partial<Record<McpScope, Record<string, unknown>>>,
  scopes: McpScope[],
  name: string,
): McpScope[] {
  return scopes.filter((scope) => disabledOf(files[scope] ?? {}).includes(name));
}

/** One file with `name` added to (or removed from) its `disabledMcpServers`. */
export function withDisabled(
  file: Record<string, unknown>,
  name: string,
  on: boolean,
): Record<string, unknown> {
  const next = { ...file };
  const list = disabledOf(next);
  const updated = on ? list.filter((n) => n !== name) : [...new Set([...list, name])];
  if (updated.length > 0) next.disabledMcpServers = updated;
  else delete next.disabledMcpServers;
  return next;
}

/** One file with its `mcpServers` replaced; every other key is preserved. */
export function withServers(
  file: Record<string, unknown>,
  servers: Record<string, McpEntry>,
): Record<string, unknown> {
  return { ...file, mcpServers: servers };
}
