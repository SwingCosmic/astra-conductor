"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llmUsage", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  getUsage: (accountId) => ipcRenderer.invoke("usage:get", accountId),
  setAccountEnabled: (accountId, enabled) =>
    ipcRenderer.invoke("accounts:set-enabled", { accountId, enabled }),
  deleteAccount: (accountId) => ipcRenderer.invoke("accounts:delete", accountId),
  refreshAccount: (accountId) => ipcRenderer.invoke("usage:refresh", accountId),
  startAuth: (provider, method) => ipcRenderer.invoke("auth:start", { provider, method }),
  finishAuth: (sessionId) => ipcRenderer.invoke("auth:finish", sessionId),
  cancelAuth: (sessionId) => ipcRenderer.invoke("auth:cancel", sessionId),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getProxy: () => ipcRenderer.invoke("system:proxy"),
});
