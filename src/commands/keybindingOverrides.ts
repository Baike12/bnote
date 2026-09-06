import { api } from "@/lib/tauri";
import { setBindingOverrides, type BindingOverrides, type BindingValue } from "./keys";

export async function loadOverrides(): Promise<BindingOverrides> {
  const stored = (await api.loadKeybindings()) as BindingOverrides | null;
  const overrides = stored ?? {};
  setBindingOverrides(overrides);
  return overrides;
}

export async function setOverride(id: string, value: BindingValue): Promise<void> {
  const stored = ((await api.loadKeybindings()) as BindingOverrides | null) ?? {};
  const next: BindingOverrides = { ...stored, [id]: value };
  await api.saveKeybindings(next);
  setBindingOverrides(next);
}

export async function clearOverride(id: string): Promise<void> {
  const stored = ((await api.loadKeybindings()) as BindingOverrides | null) ?? {};
  const next = { ...stored };
  delete next[id];
  await api.saveKeybindings(next);
  setBindingOverrides(next);
}

export async function resetAllOverrides(): Promise<void> {
  await api.saveKeybindings({});
  setBindingOverrides({});
}
