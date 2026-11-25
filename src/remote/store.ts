import { create } from "zustand";

/**
 * The UI's view of the remote channel. The backend owns the socket and the
 * settings files; this store only mirrors what the `remote-event` stream and
 * the status command report, so the settings page and the pairing prompt see
 * the same state.
 */
interface RemoteUi {
  /** online | offline | connecting | disabled */
  status: string;
  lastError: string | null;
  /** A phone finished its handshake and is waiting for the desktop's answer. */
  pendingPair: { deviceId: string; name: string } | null;
  setStatus: (status: string, error?: string | null) => void;
  setPendingPair: (pair: { deviceId: string; name: string } | null) => void;
}

export const useRemoteStore = create<RemoteUi>((set) => ({
  status: "disabled",
  lastError: null,
  pendingPair: null,
  setStatus: (status, error = null) => set({ status, lastError: error }),
  setPendingPair: (pendingPair) => set({ pendingPair }),
}));
