import { listen } from "@tauri-apps/api/event";
import { useRemoteStore } from "./store";

/**
 * App-level subscription to the remote channel's status and pairing prompts.
 *
 * It is installed once from `App.tsx`, not by the settings page: a phone can
 * finish its handshake while the user is looking at the code pane, and the
 * approval prompt must still appear when they open settings.
 */
export async function installRemoteEvents(): Promise<() => void> {
  try {
    return await listen("remote-event", (event) => {
      const data = event.payload as {
        type?: unknown;
        status?: unknown;
        error?: unknown;
        deviceId?: unknown;
        name?: unknown;
      } | null;
      if (!data || typeof data.type !== "string") return;
      const store = useRemoteStore.getState();
      if (data.type === "status" && typeof data.status === "string") {
        store.setStatus(data.status, typeof data.error === "string" ? data.error : null);
      } else if (data.type === "error" && typeof data.error === "string") {
        store.setStatus(store.status, data.error);
      } else if (
        data.type === "pairing_request" &&
        typeof data.deviceId === "string" &&
        typeof data.name === "string"
      ) {
        store.setPendingPair({ deviceId: data.deviceId, name: data.name });
      } else if (data.type === "device_paired") {
        store.setPendingPair(null);
      }
    });
  } catch {
    // Browser harness without a Tauri event source: the settings page still
    // works through the status command.
    return () => {};
  }
}
