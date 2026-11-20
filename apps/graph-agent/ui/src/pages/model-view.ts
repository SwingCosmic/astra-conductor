import { inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type {
  ActionAvailability,
  GraphModelSnapshot,
  ModelCatalogView,
  ModelSelection,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";

const protocolLabels: Record<string, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};
export function routeLabel(catalog: ModelCatalogView) {
  return `${catalog.accountDisplayName || catalog.accountId} · ${protocolLabels[catalog.protocol] ?? catalog.protocol}`;
}
export function sameRoute(catalog: ModelCatalogView, selection?: ModelSelection | null) {
  return catalog.accountId === selection?.accountId && catalog.protocol === selection.protocol;
}
export function disabledReason(action?: ActionAvailability) {
  return action?.state === "disabled" ? action.reason : undefined;
}

export function useModelView() {
  const service = inject(graphServiceKey);
  if (!service) throw new Error("GraphAgent service was not provided");
  const snapshot = shallowRef<GraphModelSnapshot | null>(null);
  const loadError = ref("");
  let generation = 0;
  let observedInstance = "";
  let observedContext = "";
  let desiredRevision = -1;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  async function reload() {
    const token = ++generation;
    // Retry an older snapshot observed during an SSE invalidation. A failed resync stays
    // visible and can be retried without submitting a command against stale data.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await service!.getSnapshot();
      if (disposed || token !== generation) return;
      if (!result.ok) {
        loadError.value = result.error.message;
        return;
      }
      const next = result.value;
      if (
        (observedInstance && observedInstance !== next.stamp.instanceId) ||
        (observedContext && observedContext !== next.backend.contextId) ||
        next.stamp.revision < desiredRevision
      )
        continue;
      observedInstance = next.stamp.instanceId;
      observedContext = next.backend.contextId;
      desiredRevision = next.stamp.revision;
      snapshot.value = next;
      loadError.value = "";
      return;
    }
    loadError.value = "模型状态已更改，请重新读取。";
  }
  onMounted(() => {
    unsubscribe = service.subscribe((event) => {
      const instance = event.stamp.instanceId;
      if (
        !event.resync &&
        instance === observedInstance &&
        event.contextId === observedContext &&
        event.reasons.length &&
        event.reasons.every((reason) => reason === "charge")
      )
        return;
      if (
        instance !== observedInstance ||
        (event.contextId && event.contextId !== observedContext)
      ) {
        snapshot.value = null;
        desiredRevision = -1;
      } else if (!event.resync && event.stamp.revision <= desiredRevision) return;
      observedInstance = instance;
      observedContext = event.contextId;
      desiredRevision = Math.max(desiredRevision, event.stamp.revision);
      void reload();
    });
    void reload();
  });
  onBeforeUnmount(() => {
    disposed = true;
    unsubscribe?.();
  });
  return { service, snapshot, loadError, reload };
}
