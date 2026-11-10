import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentConfig, ModelSelection } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { levelLabel, resolveSelection, selectionForModel, selectionTitle } from "./modelSelection";

/**
 * The model chip of the composer footer and its picker (ZCode's model menu):
 *
 *   [provider name  API  >]      the suppliers, a flyout to the right
 *   模型                          the models of that supplier
 *     deepseek-flash  视觉   ✓
 *   思考强度            最高
 *     [────slider────]
 *   管理模型                      → the settings catalog page
 *
 * The chip shows the model the open session runs on plus its thinking level.
 * Picking anything calls `onChange` immediately: the panel switches the live
 * session (the next round uses it) and appends a line to the record.
 */
export function ModelPicker({
  cfg,
  selection,
  onChange,
}: {
  cfg: AgentConfig | null;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [viewProviderId, setViewProviderId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const openSettings = useAppStore((s) => s.openSettings);

  const resolved = useMemo(() => resolveSelection(cfg, selection), [cfg, selection]);
  // While the menu is open the model list follows the provider the user picked
  // to browse; it never changes the session until a model is clicked.
  const viewProvider =
    cfg?.providers.find((p) => p.id === (viewProviderId ?? resolved?.provider.id)) ??
    resolved?.provider ??
    null;
  // The provider the menu opens on (the session's own, not the browsed one).
  const selectedProviderId = resolved?.provider.id ?? null;
  const openingProviderId = useRef<string | null>(null);
  openingProviderId.current = selectedProviderId;

  useEffect(() => {
    if (!open) {
      setProvidersOpen(false);
      return;
    }
    setViewProviderId(openingProviderId.current);
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => setOpen(false);
  const manage = () => {
    close();
    openSettings("agent-model");
  };

  const pick = (modelId: string) => {
    if (!viewProvider) return;
    const model = viewProvider.models.find((m) => m.id === modelId);
    if (!model) return;
    onChange(selectionForModel(viewProvider, model, resolved?.selection.thinking ?? ""));
    close();
  };

  const levels = resolved?.model.thinking ?? [];
  const sliderIndex = Math.max(
    0,
    levels.findIndex((l) => l.id === (resolved?.selection.thinking ?? "")),
  );
  const fill = levels.length > 1 ? (sliderIndex / (levels.length - 1)) * 100 : 100;

  return (
    <div className="agent-model" ref={ref}>
      <button
        className="agent-model-chip"
        title={selectionTitle(cfg, selection)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-model-name">{resolved?.model.name ?? "选择模型"}</span>
        {resolved && (
          <span className="agent-model-level">{levelLabel(resolved.selection.thinking)}</span>
        )}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="agent-model-pop" role="menu">
          {viewProvider ? (
            <>
              <button
                className={`agent-model-provider${providersOpen ? " is-open" : ""}`}
                onClick={() => setProvidersOpen((v) => !v)}
              >
                <span className="agent-model-provider-name">{viewProvider.name}</span>
                <span className="agent-model-api">API</span>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {providersOpen ? (
                // The supplier list replaces the body while browsing: the chip
                // sits at the pointer's end of the composer, so a flyout to the
                // right would run off the panel.
                <>
                  <div className="agent-model-section-label">供应商</div>
                  <div className="agent-model-models" role="menu">
                    {cfg?.providers.map((provider) => (
                      <button
                        key={provider.id}
                        className={`agent-model-model-item${
                          provider.id === viewProvider.id ? " is-active" : ""
                        }`}
                        onClick={() => {
                          setViewProviderId(provider.id);
                          setProvidersOpen(false);
                        }}
                      >
                        <span className="agent-model-model-name">{provider.name}</span>
                        <span className="agent-model-api">API</span>
                        {provider.id === resolved?.provider.id && (
                          <span className="agent-model-check">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="agent-model-section-label">模型</div>
                  <div className="agent-model-models">
                    {viewProvider.models.map((model) => {
                      const active =
                        resolved?.provider.id === viewProvider.id && resolved.model.id === model.id;
                      return (
                        <button
                          key={model.id}
                          className={`agent-model-model-item${active ? " is-active" : ""}`}
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => pick(model.id)}
                        >
                          <span className="agent-model-model-name">{model.name}</span>
                          {model.vision && <span className="agent-model-tag">视觉</span>}
                          {active && <span className="agent-model-check">✓</span>}
                        </button>
                      );
                    })}
                    {viewProvider.models.length === 0 && (
                      <div className="agent-model-empty">这个供应商还没有模型</div>
                    )}
                  </div>
                  {levels.length > 0 && (
                    <div className="agent-model-thinking">
                      <div className="agent-model-thinking-head">
                        <span>思考强度</span>
                        <span className="agent-model-thinking-value">
                          {levelLabel(resolved?.selection.thinking ?? "")}
                        </span>
                      </div>
                      <input
                        className="agent-model-slider"
                        type="range"
                        min={0}
                        max={Math.max(0, levels.length - 1)}
                        step={1}
                        value={sliderIndex}
                        style={{ "--fill": `${fill}%` } as CSSProperties}
                        onChange={(e) => {
                          const level = levels[Number(e.target.value)];
                          if (!level || !resolved) return;
                          onChange({
                            provider_id: resolved.provider.id,
                            model_id: resolved.model.id,
                            thinking: level.id,
                          });
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="agent-model-empty">还没有配置供应商与模型</div>
          )}
          <button className="agent-model-manage" onClick={manage}>
            管理模型
          </button>
        </div>
      )}
    </div>
  );
}
