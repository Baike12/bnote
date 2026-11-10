/**
 * The catalog's pure logic: resolving a {@link ModelSelection} against the
 * provider/model list, level labels and slider positions, and the JSON patch
 * validation the settings editor needs.
 *
 * Components only render what these return; every rule (fallbacks, ordering,
 * what "inherit" means) is here so it can be tested without a DOM.
 */

import type {
  AgentConfig,
  ModelEntry,
  ModelSelection,
  ProviderEntry,
  SessionModelConfig,
} from "@/lib/tauri";

/** The labels of the conventional level ids; any other id shows as itself. */
const LEVEL_LABELS: Record<string, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};

export function levelLabel(id: string): string {
  return LEVEL_LABELS[id] ?? id;
}

/** A selection plus the catalog entries it points at. */
export interface ResolvedSelection {
  provider: ProviderEntry;
  model: ModelEntry;
  selection: ModelSelection;
  /** The level inside `model.thinking` (0 = lowest). */
  levelIndex: number;
}

export function findProvider(cfg: AgentConfig | null, id: string): ProviderEntry | null {
  return cfg?.providers.find((p) => p.id === id) ?? null;
}

export function findModel(provider: ProviderEntry | null, id: string): ModelEntry | null {
  return provider?.models.find((m) => m.id === id) ?? null;
}

/** The level a model starts on: its declared default, else the highest. */
export function defaultLevel(model: ModelEntry): string {
  const declared = model.thinking.find((l) => l.id === model.default_thinking);
  if (declared) return declared.id;
  return model.thinking[model.thinking.length - 1]?.id ?? "";
}

export function levelIndexOf(model: ModelEntry, id: string): number {
  const index = model.thinking.findIndex((l) => l.id === id);
  return index >= 0 ? index : Math.max(0, model.thinking.length - 1);
}

export function levelAt(model: ModelEntry, index: number): string {
  if (model.thinking.length === 0) return "";
  const clamped = Math.min(Math.max(0, Math.round(index)), model.thinking.length - 1);
  return model.thinking[clamped]?.id ?? "";
}

/** Resolves a selection: the selection itself when the catalog still has it, else the configured default, else the first model. */
export function resolveSelection(
  cfg: AgentConfig | null,
  selection: ModelSelection | null,
): ResolvedSelection | null {
  if (!cfg) return null;
  const candidates: ModelSelection[] = [];
  if (selection) candidates.push(selection);
  if (cfg.default_selection) candidates.push(cfg.default_selection);
  for (const candidate of candidates) {
    const provider = findProvider(cfg, candidate.provider_id);
    const model = findModel(provider, candidate.model_id);
    if (!provider || !model) continue;
    const level = model.thinking.some((l) => l.id === candidate.thinking)
      ? candidate.thinking
      : defaultLevel(model);
    return {
      provider,
      model,
      selection: { ...candidate, thinking: level },
      levelIndex: levelIndexOf(model, level),
    };
  }
  const provider = cfg.providers[0];
  const model = provider?.models[0];
  if (!provider || !model) return null;
  const level = defaultLevel(model);
  return {
    provider,
    model,
    selection: { provider_id: provider.id, model_id: model.id, thinking: level },
    levelIndex: levelIndexOf(model, level),
  };
}

/**
 * The selection of one session: its own recorded selection first (a session
 * keeps the model it was switched to), then the selection implied by its model
 * snapshot (records written before the catalog), then the current default.
 */
export function sessionSelection(
  cfg: AgentConfig | null,
  own: ModelSelection | null | undefined,
  snapshot: SessionModelConfig | null | undefined,
): ModelSelection | null {
  // Only a selection the catalog still has counts: a deleted provider must not
  // keep the chip claiming a model a fresh start could not resolve.
  if (
    own &&
    findProvider(cfg, own.provider_id) &&
    findModel(findProvider(cfg, own.provider_id), own.model_id)
  ) {
    return own;
  }
  if (snapshot && cfg) {
    const provider =
      findProvider(cfg, snapshot.providerId ?? "") ??
      cfg.providers.find((p) => p.models.some((m) => m.id === snapshot.model));
    const model = findModel(provider ?? null, snapshot.modelId ?? snapshot.model);
    if (provider && model) {
      const wanted = snapshot.thinking ?? "";
      return {
        provider_id: provider.id,
        model_id: model.id,
        thinking: model.thinking.some((l) => l.id === wanted) ? wanted : defaultLevel(model),
      };
    }
  }
  return resolveSelection(cfg, null)?.selection ?? null;
}

/** Choosing a model keeps the current level when the new model has it, else takes the model's default (ZCode's rule). */
export function selectionForModel(
  provider: ProviderEntry,
  model: ModelEntry,
  currentThinking: string,
): ModelSelection {
  const level = model.thinking.some((l) => l.id === currentThinking)
    ? currentThinking
    : defaultLevel(model);
  return { provider_id: provider.id, model_id: model.id, thinking: level };
}

/** `provider/model` for the tooltip of the chip (the chip itself shows the model name only). */
export function selectionTitle(cfg: AgentConfig | null, selection: ModelSelection | null): string {
  const resolved = resolveSelection(cfg, selection);
  if (!resolved) return "未配置模型";
  return `${resolved.provider.name}/${resolved.model.name} · 思考强度 ${levelLabel(resolved.selection.thinking)}`;
}

/** The parsed patch of a level editor's textarea. */
export type PatchParse =
  { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

/**
 * A level patch must be a JSON object (RFC 7396): `null` values delete fields,
 * anything else is written into the request body verbatim. Refusing the save
 * here is what keeps a broken body away from the gateway.
 */
export function parsePatch(text: string): PatchParse {
  const raw = text.trim();
  if (!raw) return { ok: true, patch: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON 无效:${e instanceof Error ? e.message : String(e)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: '必须是一个 JSON 对象,例如 {"thinking":{"type":"enabled"}}' };
  }
  return { ok: true, patch: value as Record<string, unknown> };
}

export function formatPatch(patch: unknown): string {
  if (!patch || typeof patch !== "object") return "{}";
  if (Object.keys(patch as Record<string, unknown>).length === 0) return "{}";
  return JSON.stringify(patch, null, 2);
}

/** The next model of the catalog in flat order (keyboard / "switch model" convenience). */
export function nextModel(
  cfg: AgentConfig | null,
  current: ModelSelection | null,
  step: 1 | -1,
): ModelSelection | null {
  if (!cfg) return null;
  const flat: { provider: ProviderEntry; model: ModelEntry }[] = [];
  for (const provider of cfg.providers) {
    for (const model of provider.models) flat.push({ provider, model });
  }
  if (flat.length === 0) return null;
  const index = flat.findIndex(
    (entry) => entry.provider.id === current?.provider_id && entry.model.id === current?.model_id,
  );
  const next = index < 0 ? flat[0] : flat[(index + step + flat.length) % flat.length];
  if (!next) return null;
  return selectionForModel(next.provider, next.model, current?.thinking ?? "");
}
