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
    subagent_concurrency: 4,
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

  it("is stable under a second conversion, so saving twice writes the same bytes", () => {
    const first = fromDraft(toDraft(config()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = fromDraft(toDraft({ ...config(), ...first.parts }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.parts).toEqual(first.parts);
  });

  it("keeps zero and false as values, not as missing fields", () => {
    const cfg = config();
    const model = cfg.providers[0]?.models[0];
    if (!model) throw new Error("fixture");
    model.max_tokens = 0;
    model.context_window = 0;
    model.vision = false;
    const result = fromDraft(toDraft(cfg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = result.parts.providers[0]?.models[0];
    expect(saved?.max_tokens).toBe(0);
    expect(saved?.context_window).toBe(0);
    expect(saved?.vision).toBe(false);
  });
});

describe("validation refuses anything a session could not run", () => {
  it("refuses a patch that parses to a non-object", () => {
    for (const text of ["[1, 2]", '"high"', "42", "null", "true"]) {
      const draft = toDraft(config());
      const level = draft.providers[0]?.models[0]?.thinking[0];
      if (!level) throw new Error("fixture");
      level.text = text;
      const result = fromDraft(draft);
      expect(result.ok, text).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0], text).toContain("JSON 对象");
    }
  });

  it("accepts an empty patch and treats it as no override", () => {
    const draft = toDraft(config());
    const level = draft.providers[0]?.models[0]?.thinking[0];
    if (!level) throw new Error("fixture");
    level.text = "   ";
    const result = fromDraft(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.providers[0]?.models[0]?.thinking[0]?.patch).toEqual({});
  });

  it("collects every bad level in catalog order and returns no partial parts", () => {
    const cfg = config();
    const second = cfg.providers[0]?.models[0];
    if (!second) throw new Error("fixture");
    cfg.providers.push({
      ...cfg.providers[0]!,
      id: "other",
      name: "other",
      models: [
        { ...second, id: "m1", name: "m1", thinking: [{ id: "low", patch: {} }] },
        { ...second, id: "m2", name: "m2", thinking: [{ id: "max", patch: {} }] },
      ],
    });
    const draft = toDraft(cfg);
    const firstLevel = draft.providers[0]?.models[0]?.thinking[1];
    const low = draft.providers[1]?.models[0]?.thinking[0];
    const max = draft.providers[1]?.models[1]?.thinking[0];
    if (!firstLevel || !low || !max) throw new Error("fixture");
    firstLevel.text = "{";
    low.text = "[";
    max.text = "nope";
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("parts" in result).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("annto");
    expect(result.errors[0]).toContain("high");
    expect(result.errors[1]).toContain("other");
    expect(result.errors[1]).toContain("m1");
    expect(result.errors[1]).toContain("low");
    expect(result.errors[2]).toContain("m2");
    expect(result.errors[2]).toContain("max");
  });

  it("names a fully empty provider, model and level by placeholder", () => {
    // The message uses the raw (untrimmed) draft, so only an empty string
    // reaches the placeholder; whitespace is still a name the user typed.
    const draft = toDraft(config());
    const provider = draft.providers[0];
    if (!provider) throw new Error("fixture");
    provider.id = "";
    provider.name = "";
    const model = provider.models[0];
    if (!model) throw new Error("fixture");
    model.id = "";
    model.name = "";
    const level = model.thinking[0];
    if (!level) throw new Error("fixture");
    level.id = "";
    level.text = "{";
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("新供应商");
    expect(result.errors[0]).toContain("新模型");
    expect(result.errors[0]).toContain("档位 ?");
  });

  it("keeps whitespace-only names in the message, matching what the user sees", () => {
    const draft = toDraft(config());
    const provider = draft.providers[0];
    if (!provider) throw new Error("fixture");
    provider.id = "  ";
    provider.name = "  ";
    const level = provider.models[0]?.thinking[0];
    if (!level) throw new Error("fixture");
    level.text = "{";
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("档位 off");
    expect(result.errors[0]).not.toContain("新供应商");
  });

  it("falls back to the id when only the display name is blank", () => {
    const draft = toDraft(config());
    const provider = draft.providers[0];
    if (!provider) throw new Error("fixture");
    provider.name = "";
    const model = provider.models[0];
    if (!model) throw new Error("fixture");
    model.name = "";
    const level = model.thinking[0];
    if (!level) throw new Error("fixture");
    level.id = "off";
    level.text = "{";
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("annto");
    expect(result.errors[0]).toContain("deepseek-flash");
    expect(result.errors[0]).toContain("档位 off");
  });

  it("leaves the draft untouched, so a refused save stays editable", () => {
    const draft = toDraft(config());
    const level = draft.providers[0]?.models[0]?.thinking[1];
    if (!level) throw new Error("fixture");
    level.text = '{"reasoning_effort":';
    const before = structuredClone(draft);
    const result = fromDraft(draft);
    expect(result.ok).toBe(false);
    expect(draft).toEqual(before);
  });
});

describe("the draft does not write through to the loaded config", () => {
  it("gives every provider and model its own object", () => {
    const cfg = config();
    const draft = toDraft(cfg);
    const provider = draft.providers[0];
    const model = provider?.models[0];
    if (!provider || !model) throw new Error("fixture");
    provider.name = "renamed";
    model.name = "renamed";
    model.thinking[0].text = "{}";
    expect(cfg.providers[0]?.name).toBe("annto");
    expect(cfg.providers[0]?.models[0]?.name).toBe("deepseek-flash");
    expect(cfg.providers[0]?.models[0]?.thinking[0]?.patch).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("copies the per-definition subagent map instead of sharing it", () => {
    const cfg = config();
    const draft = toDraft(cfg);
    draft.subagent_models.by_definition.explore = {
      provider_id: "x",
      model_id: "y",
      thinking: "off",
    };
    draft.subagent_models.by_definition.added = {
      provider_id: "x",
      model_id: "y",
      thinking: "off",
    };
    expect(cfg.subagent_models.by_definition.explore?.provider_id).toBe("annto");
    expect("added" in cfg.subagent_models.by_definition).toBe(false);
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

  it("number a fresh entry from its index", () => {
    expect(newProvider(0).id).toBe("provider-1");
    expect(newProvider(4).id).toBe("provider-5");
    expect(newProvider(0).name).toBe("供应商 1");
    expect(newModel(2).id).toBe("model-3");
    expect(newModel(2).name).toBe("模型 3");
  });

  it("skip past every collision, not only the next one", () => {
    const providers = [
      { ...newProvider(0), id: "provider-1" },
      { ...newProvider(1), id: "provider-2" },
      { ...newProvider(2), id: "provider-3" },
    ];
    expect(newProvider(0, providers).id).toBe("provider-4");
    const models = [newModel(0), newModel(1), newModel(2)];
    expect(newModel(0, models).id).toBe("model-4");
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

  it("start a provider with one model whose id is free", () => {
    const provider = newProvider(0);
    const model = provider.models[0];
    expect(model?.id).toBe("model-1");
    expect(model?.vision).toBe(false);
    expect(model?.default_thinking).toBe("");
  });
});
