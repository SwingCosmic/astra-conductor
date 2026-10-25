import type { BrowserWindow, Session } from "electron";

export function installPageCsp(
  appSession: Session,
  devOrigin?: string,
  webApiOrigin?: string,
): void {
  const scripts = devOrigin ? "'self' 'unsafe-inline'" : "'self'";
  const connections = devOrigin
    ? `'self' polyquota-app: ${devOrigin} ${devOrigin.replace(/^http/, "ws")}`
    : "'self' polyquota-app:";
  const allowedConnections = webApiOrigin ? `${connections} ${webApiOrigin}` : connections;
  appSession.webRequest.onHeadersReceived((details, callback) => {
    // The Node development server enforces its own API boundary; do not attach
    // renderer document CSP to upstream provider responses.
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https: polyquota-app:; font-src 'self' data: https: polyquota-app:; connect-src ${allowedConnections}; frame-src 'none'; object-src 'none'; base-uri 'self'`,
        ],
      },
    });
  });
}

export function guardPage(window: BrowserWindow, entryUrl: string, aborted: () => void): void {
  const trusted = new URL(entryUrl);
  trusted.hash = "";
  window.webContents.on("will-frame-navigate", (event) => {
    const candidate = new URL(event.url);
    candidate.hash = "";
    if (!event.isMainFrame || candidate.href !== trusted.href) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) aborted();
  });
  window.on("closed", aborted);
}
