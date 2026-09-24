"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llmUsage", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  getUsage: (accountId) => ipcRenderer.invoke("usage:get", accountId),
  setAccountEnabled: (accountId, enabled) =>
    ipcRenderer.invoke("accounts:set-enabled", { accountId, enabled }),
  deleteAccount: (accountId) => ipcRenderer.invoke("accounts:delete", accountId),
  refreshAccount: (accountId) => ipcRenderer.invoke("usage:refresh", accountId),
});
