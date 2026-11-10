import { describe, expect, it } from "vitest";
import type { AgentConfig, ModelEntry, ProviderEntry } from "@/lib/tauri";
import {
  defaultLevel,
  levelAt,
  levelIndexOf,
  levelLabel,
  nextModel,
  parsePatch,
  resolveSelection,
  selectionForModel,
  sessionSelection,
} from "./modelSelection";

/**
 * The catalog's rules: which model a session runs on, what a level of a model
 * means, and what may be saved as a patch. The picker and the settings page
 * both render these results, so a mistake here is a wrong request.
 */

function model(id: string, levels: string[], fallback = ""): ModelEntry {
  return {
    id,
    name: id,
    context_window: 128_000,
    max_tokens: 8_192,
    vision: id.startsWith("vision"),
    thinking: levels.map((level) => ({ id: level, patch: { level } })),
    default_thinking: fallback,
  };
}

function provider(id: string, models: ModelEntry[]): ProviderEntry {
  return { id, name: id, protocol: "openai", base_url: "", api_key: "k", models };
}

function config(providers: ProviderEntry[], preselected?: [string, string, string]): AgentConfig {
  return {
    providers,
    default_selection: preselected
      ? { provider_id: preselected[0], model_id: preselected[1], thinking: preselected[2] }
      : null,
    subagent_models: { default: null, by_definition: {} },
    provider: "openai",
    model: "",
    base_url: "",
    api_key: "",
    max_tokens: 8_192,
    context_window: 128_000,
    agent_roots: {},
  };
}

describe("level labels and slider positions", () => {
  it("labels the conventional ids and shows an unknown one as itself", () => {
    expect(levelLabel("off")).toBe("关闭");
    expect(levelLabel("max")).toBe("最高");
    expect(levelLabel("ultra")).toBe("ultra");
  });

  it("maps an index to a level and back, clamped at both ends", () => {
    const m = model("m", ["off", "low", "high"]);
    expect(levelAt(m, 0)).toBe("off");
    expect(levelAt(m, 2)).toBe("high");
    expect(levelAt(m, 7)).toBe("high");
    expect(levelAt(m, -3)).toBe("off");
    expect(levelIndexOf(m, "low")).toBe(1);
    // A missing id falls back to the highest level, the same rule as the
    // backend's resolve.
    expect(levelIndexOf(m, "nope")).toBe(2);
    expect(levelAt(model("empty", []), 0)).toBe("");
  });

  it("starts a model on its declared default, else the highest", () => {
    expect(defaultLevel(model("m", ["off", "high"], "high"))).toBe("high");
    expect(defaultLevel(model("m", ["off", "high"]))).toBe("high");
    expect(defaultLevel(model("m", []))).toBe("");
  });
});

describe("resolving a selection", () => {
  const cfg = config([
    provider("a", [model("a1", ["off", "high"])]),
    provider("b", [model("b1", ["low"])]),
  ]);

  it("keeps a still-valid selection", () => {
    const resolved = resolveSelection(cfg, { provider_id: "b", model_id: "b1", thinking: "low" });
    expect(resolved?.provider.id).toBe("b");
    expect(resolved?.selection.thinking).toBe("low");
  });

  it("replaces a level the model no longer declares with its default", () => {
    const resolved = resolveSelection(cfg, { provider_id: "a", model_id: "a1", thinking: "max" });
    expect(resolved?.selection.thinking).toBe("high");
  });

  it("falls back to the default selection, then to the first model", () => {
    const withDefault = config(cfg.providers, ["b", "b1", "low"]);
    expect(
      resolveSelection(withDefault, { provider_id: "gone", model_id: "x", thinking: "" })?.model.id,
    ).toBe("b1");
    expect(resolveSelection(cfg, null)?.model.id).toBe("a1");
    expect(resolveSelection(config([]), null)).toBeNull();
    expect(resolveSelection(null, null)).toBeNull();
  });

  it("takes the level of the segment the picker shows", () => {
    const resolved = resolveSelection(cfg, { provider_id: "a", model_id: "a1", thinking: "off" });
    expect(resolved?.levelIndex).toBe(0);
  });
});

describe("a session's selection", () => {
  const cfg = config([provider("a", [model("a1", ["off", "high"], "high")])]);

  it("prefers the selection the session recorded", () => {
    const selection = sessionSelection(
      cfg,
      { provider_id: "a", model_id: "a1", thinking: "off" },
      null,
    );
    expect(selection?.thinking).toBe("off");
  });

  it("derives it from a pre-catalog snapshot", () => {
    const selection = sessionSelection(cfg, null, {
      provider: "openai",
      model: "a1",
      baseUrl: "",
      maxTokens: 8192,
      contextWindow: 128000,
      thinking: "off",
    });
    expect(selection).toEqual({ provider_id: "a", model_id: "a1", thinking: "off" });
  });

  it("falls back to the configured default", () => {
    const withDefault = config(cfg.providers, ["a", "a1", "high"]);
    expect(sessionSelection(withDefault, null, null)).toEqual({
      provider_id: "a",
      model_id: "a1",
      thinking: "high",
    });
  });

  it("keeps the current level when the next model has it", () => {
    const first = provider("a", [
      model("a1", ["off", "high"]),
      model("a2", ["off", "high"], "high"),
    ]);
    expect(selectionForModel(first, first.models[1]!, "off").thinking).toBe("off");
    const second = provider("b", [model("b1", ["low"], "low")]);
    expect(selectionForModel(second, second.models[0]!, "high").thinking).toBe("low");
  });
});

describe("the flat model order", () => {
  const cfg = config([
    provider("a", [model("a1", ["high"], "high")]),
    provider("b", [model("b1", ["high"], "high")]),
  ]);

  it("steps forward, wraps around, and starts at the first model", () => {
    expect(
      nextModel(cfg, { provider_id: "a", model_id: "a1", thinking: "high" }, 1)?.model_id,
    ).toBe("b1");
    expect(
      nextModel(cfg, { provider_id: "b", model_id: "b1", thinking: "high" }, 1)?.model_id,
    ).toBe("a1");
    expect(
      nextModel(cfg, { provider_id: "b", model_id: "b1", thinking: "high" }, -1)?.model_id,
    ).toBe("a1");
    expect(nextModel(cfg, null, 1)?.model_id).toBe("a1");
    expect(nextModel(config([]), null, 1)).toBeNull();
  });
});

describe("a level patch", () => {
  it("accepts an object, including the empty one", () => {
    expect(parsePatch("")).toEqual({ ok: true, patch: {} });
    expect(parsePatch('{"thinking":{"type":"enabled"}}')).toEqual({
      ok: true,
      patch: { thinking: { type: "enabled" } },
    });
  });

  it("refuses broken JSON and non-objects", () => {
    expect(parsePatch('{"thinking":').ok).toBe(false);
    expect(parsePatch("[1,2]").ok).toBe(false);
    expect(parsePatch("null").ok).toBe(false);
    expect(parsePatch('"x"').ok).toBe(false);
  });
});
