(async () => {
  if ("polyQuotaElectronService" in window) throw new Error("legacy-business-bridge");
  const base = "polyquota-app://app";
  const request = async (path, body, post = false) => {
    const response = await fetch(base + path, {
      method: post ? "POST" : "GET",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return response.json();
  };
  const stream = await fetch(base + "/v1/polyquota/events");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextEvent = async () => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const line = frame.split("\n").find((line) => line.startsWith("data: "));
        if (line) return JSON.parse(line.slice(6));
      } else {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream-ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
  await nextEvent();
  const service = {
    getSnapshot: () => request("/v1/polyquota/snapshot"),
    deleteAccount: (id) =>
      request("/v1/polyquota/accounts/" + encodeURIComponent(id) + "/delete", undefined, true),
    saveSettings: (settings) => request("/v1/polyquota/settings/save", settings, true),
  };
  const initialResult = await service.getSnapshot();
  if (!initialResult.ok) throw new Error(initialResult.error.code);
  const invalidResult = await service.deleteAccount("../invalid-account");
  if (invalidResult.ok || invalidResult.error.code !== "validation") {
    throw new Error("invalid-input-not-rejected");
  }
  const initial = initialResult.value;
  const eventPromise = (async () => {
    for (;;) {
      const event = await nextEvent();
      if (event.revision > initial.revision) return event;
    }
  })();
  const changedSettings = {
    ...initial.settings,
    pollingEnabled: !initial.settings.pollingEnabled,
  };
  const saveResult = await service.saveSettings(changedSettings);
  if (!saveResult.ok) throw new Error(saveResult.error.code);
  const event = await eventPromise;
  const changedResult = await service.getSnapshot();
  if (!changedResult.ok) throw new Error(changedResult.error.code);
  if (changedResult.value.revision < event.revision) throw new Error("stale-snapshot");
  if (changedResult.value.settings.pollingEnabled !== changedSettings.pollingEnabled) {
    throw new Error("settings-not-applied");
  }
  const restoreResult = await service.saveSettings(initial.settings);
  if (!restoreResult.ok) throw new Error(restoreResult.error.code);
  await reader.cancel();
  const deadline = Date.now() + 5000;
  while (!document.querySelector(".app-shell")) {
    if (Date.now() > deadline) throw new Error("UI-not-mounted");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const caps = await request("/v1/host/capabilities");
  if (!caps.ok || !caps.value.desktop || caps.value.notifications !== "host")
    throw new Error("host-capabilities");
  const icon = await fetch("polyquota-app://resources/product-icon");
  if (
    !icon.ok ||
    icon.headers.get("content-type") !== "image/png" ||
    !(await icon.arrayBuffer()).byteLength
  )
    throw new Error("dynamic-resource");
  return { revision: changedResult.value.revision, reasons: event.reasons };
})();
