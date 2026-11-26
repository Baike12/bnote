import { create } from "zustand";

/**
 * The UI's view of the remote channel. The backend owns the socket and the
 * settings files; this store only mirrors what the `remote-event` stream
 * reports, so the settings page sees status changes it did not trigger.
 */
interface RemoteUi {
  /** online | offline | connecting | disabled */
  status: string;
  lastError: string | null;
  setStatus: (status: string, error?: string | null) => void;
}

export const useRemoteStore = create<RemoteUi>((set) => ({
  status: "disabled",
  lastError: null,
  setStatus: (status, error = null) => set({ status, lastError: error }),
}));
