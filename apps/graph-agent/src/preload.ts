import { contextBridge, ipcRenderer } from "electron";
import type { GraphApi } from "./contract.js";
const invoke = async <T>(method: string, input?: unknown): Promise<T> => {
  const result = (await ipcRenderer.invoke("graph-agent:sharing", method, input)) as {
    ok: boolean;
    value?: T;
    error?: string;
  };
  if (!result.ok) throw new Error(result.error ?? "operation-failed");
  return result.value as T;
};
const api: GraphApi = {
  status: () => invoke("status"),
  selectDirectory: () => invoke("selectDirectory"),
  install: () => invoke("install"),
  uninstall: () => invoke("uninstall"),
  verifyImport: (input) => invoke("verifyImport", input),
  confirmImport: (previewId) => invoke("confirmImport", previewId),
  cancelPreview: () => invoke("cancelPreview"),
  retry: () => invoke("retry"),
  refresh: (id) => invoke("refresh", id),
};
contextBridge.exposeInMainWorld("graphAgent", api);
