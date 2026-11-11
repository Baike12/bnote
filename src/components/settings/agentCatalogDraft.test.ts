import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@/lib/tauri";
import { fromDraft, newModel, newProvider, toDraft } from "./agentCatalogDraft";

/**
 * The settings draft: the page edits patch text, the config holds objects. A
 * conversion mistake would either lose a mapping or send a broken body to the
 * gateway, so both directions are pinned here.
 */

function config(): AgentConfig {
  return {
    providers: [
      {
        id: "annto",
        name: "annto",
        protocol: "openai",
        base_url: "https://example.test/v1",
        api_key: "sk",
        models: [
          {
            id: "deepseek-flash",
            name: "deepseek-flash",
            context_window: 128_000,
            max_tokens: 8_192,
            vision: true,
            thinking: [
              { id: "off", patch: { thinking: { type: "disabled" } } },
              { id: "high", patch: { reasoning_effort: "high" } },
            ],
            default_thinking: "high",
          },
        ],
      },
    ],
    default_selection: { provider_id: "annto", model_id: "deepseek-flash", thinking: "high" },
    subagent_models: {
      default: null,
      by_definition: {
        explore: { provider_id: "annto", model_id: "deepseek-flash", thinking: "off" },
      },
    },
    provider: "openai",
    model: "deepseek-flash",
    base_url: "https://example.test/v1",
    api_key: "sk",
    max_tokens: 8_192,
    context_window: 128_000,
    agent_roots: {},
    log_requests: false,
  };
}

describe("catalog draft round trip", () => {
  it("keeps every field of the catalog", () => {
    const draft = toDraft(config());
    const result = fromDraft(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.providers).toEqual(config().providers);
    expect(result.parts.default_selection).toEqual(config().default_selection);
    expect(result.parts.subagent_models.by_definition.explore.thinking).toBe("off");
    expect(result.parts.default_selection?.thinking).toBe("high");
  });

  it("refuses a patch that is still being typed and names the field", () => {
    const draft = toDraft(config());
    const level = draft.providers[0]?.models[0]?.thinking[1];
    if (!level) throw new Error("fixture");
    level.text = '{"reasoning_effort":';
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("annto");
    expect(result.errors[0]).toContain("deepseek-flash");
    expect(result.errors[0]).toContain("high");
  });

  it("trims ids and names and drops nothing else", () => {
    const draft = toDraft(config());
    const provider = draft.providers[0];
    if (!provider) throw new Error("fixture");
    provider.id = "  annto  ";
    provider.name = " annto ";
    const model = provider.models[0];
    if (!model) throw new Error("fixture");
    model.id = " m ";
    model.thinking[0] = { id: " off ", text: "{}" };
    const result = fromDraft(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.providers[0]?.id).toBe("annto");
    expect(result.parts.providers[0]?.models[0]?.id).toBe("m");
    expect(result.parts.providers[0]?.models[0]?.thinking[0]?.id).toBe("off");
  });
});

describe("new entries", () => {
  it("start with a placeholder identity the backend replaces on save", () => {
    const provider = newProvider(0);
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]?.thinking).toEqual([]);
    const model = newModel(1);
    expect(model.context_window).toBe(128_000);
    expect(model.max_tokens).toBe(8_192);
    expect(
      fromDraft({
        providers: [provider],
        default_selection: null,
        subagent_models: { default: null, by_definition: {} },
      }).ok,
    ).toBe(true);
  });

  // Provider ids are what a selection names: two providers sharing one id make
  // every lookup hit the first, so the second can never be selected. Deleting a
  // provider and adding another used to produce exactly that collision.
  it("never reuse an id that is already taken", () => {
    const existing = [newProvider(0), newProvider(1)];
    expect(existing.map((p) => p.id)).toEqual(["provider-1", "provider-2"]);
    const kept = existing[1];
    if (!kept) throw new Error("fixture");
    const afterDelete = newProvider(existing.length, [kept]);
    expect(afterDelete.id).toBe("provider-3");

    const models = [newModel(0), newModel(1)];
    expect(newModel(1, models).id).toBe("model-3");
  });
});
