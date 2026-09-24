"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llmUsage", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  getUsage: (accountId) => ipcRenderer.invoke("usage:get", accountId),
  setAccountEnabled: (accountId, enabled) =>
    ipcRenderer.invoke("accounts:set-enabled", { accountId, enabled }),
  deleteAccount: (accountId) => ipcRenderer.invoke("accounts:delete", accountId),
  refreshAccount: (accountId) => ipcRenderer.invoke("usage:refresh", accountId),
  importCodexCli: () => ipcRenderer.invoke("auth:codex-cli"),
  loginCodexBrowser: () => ipcRenderer.invoke("auth:codex-browser"),
  startCodexDevice: () => ipcRenderer.invoke("auth:codex-device-start"),
  finishCodexDevice: (sessionId) => ipcRenderer.invoke("auth:codex-device-finish", sessionId),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getProxy: () => ipcRenderer.invoke("system:proxy"),
});
