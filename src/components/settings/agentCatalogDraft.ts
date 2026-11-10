/**
 * The settings page's draft shape of the model catalog.
 *
 * A thinking level's patch is edited as JSON text, but the saved config holds
 * objects: the drafts keep the text the user is typing (an intermediate
 * `{"thinking":` is still displayable, an object cannot hold it), and
 * {@link fromDraft} converts and validates on save. Keeping the text inside
 * the draft — instead of a second state beside the config — means one writer
 * and no "which one is the truth" question.
 */

import type { AgentConfig, ModelSelection, SubagentModels } from "@/lib/tauri";
import { formatPatch, parsePatch } from "@/components/agent/modelSelection";

export interface LevelDraft {
  id: string;
  /** The patch as JSON text (validated when the page saves). */
  text: string;
}

export interface ModelDraft {
  id: string;
  name: string;
  context_window: number;
  max_tokens: number;
  vision: boolean;
  thinking: LevelDraft[];
  default_thinking: string;
}

export interface ProviderDraft {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key: string;
  models: ModelDraft[];
}

export interface CatalogDraft {
  providers: ProviderDraft[];
  default_selection: ModelSelection | null;
  subagent_models: SubagentModels;
}

export type CatalogDraftParts = Pick<
  AgentConfig,
  "providers" | "default_selection" | "subagent_models"
>;

export function toDraft(cfg: AgentConfig): CatalogDraft {
  return {
    providers: cfg.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      base_url: provider.base_url,
      api_key: provider.api_key,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        vision: model.vision,
        thinking: model.thinking.map((level) => ({
          id: level.id,
          text: formatPatch(level.patch),
        })),
        default_thinking: model.default_thinking,
      })),
    })),
    default_selection: cfg.default_selection,
    subagent_models: {
      default: cfg.subagent_models.default,
      by_definition: { ...cfg.subagent_models.by_definition },
    },
  };
}

/** The result of a save: the catalog, or the fields that refuse to save. */
export type DraftResult = { ok: true; parts: CatalogDraftParts } | { ok: false; errors: string[] };

/**
 * Converts the drafts back to the config shape. Every level patch must parse
 * to an object: a half-typed textarea must never reach the gateway as a broken
 * request body, so the save is refused with a message naming the field.
 */
export function fromDraft(draft: CatalogDraft): DraftResult {
  const errors: string[] = [];
  const providers = draft.providers.map((provider) => ({
    id: provider.id.trim(),
    name: provider.name.trim(),
    protocol: provider.protocol,
    base_url: provider.base_url.trim(),
    api_key: provider.api_key,
    models: provider.models.map((model) => {
      const thinking = model.thinking.map((level) => {
        const parsed = parsePatch(level.text);
        if (!parsed.ok) {
          errors.push(
            `${provider.name || provider.id || "新供应商"} / ${model.name || model.id || "新模型"} / 档位 ${level.id || "?"}: ${parsed.error}`,
          );
          return { id: level.id.trim(), patch: {} };
        }
        return { id: level.id.trim(), patch: parsed.patch };
      });
      return {
        id: model.id.trim(),
        name: model.name.trim(),
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        vision: model.vision,
        thinking,
        default_thinking: model.default_thinking,
      };
    }),
  }));
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    parts: {
      providers,
      default_selection: draft.default_selection,
      subagent_models: draft.subagent_models,
    },
  };
}

/**
 * A fresh provider draft. The id must be unique: provider ids are what a
 * selection and a session snapshot name, and a duplicate — which a delete plus
 * "add" produces when the id comes from the list length — makes every lookup
 * hit the first one, so the second provider can never be selected.
 */
export function newProvider(index: number, existing: readonly ProviderDraft[] = []): ProviderDraft {
  const taken = new Set(existing.map((p) => p.id));
  let n = index + 1;
  while (taken.has(`provider-${n}`)) n += 1;
  return {
    id: `provider-${n}`,
    name: `供应商 ${n}`,
    protocol: "openai",
    base_url: "",
    api_key: "",
    models: [newModel(0)],
  };
}

/** A fresh model draft; the same uniqueness rule inside one provider. */
export function newModel(index: number, existing: readonly ModelDraft[] = []): ModelDraft {
  const taken = new Set(existing.map((m) => m.id));
  let n = index + 1;
  while (taken.has(`model-${n}`)) n += 1;
  return {
    id: `model-${n}`,
    name: `模型 ${n}`,
    context_window: 128_000,
    max_tokens: 8_192,
    vision: false,
    thinking: [],
    default_thinking: "",
  };
}
