import {
  graphModelOperations,
  graphModelEventChannel,
  testChatOperation,
  getChatChargeOperation,
  closeChatResultOperation,
  type IGraphAgentService,
} from "@astra-conductor/contract/graph-agent";
import { defineServiceSlice, ServiceClientBase } from "@astra-conductor/shared-ui/services";

export const withGraphModels = defineServiceSlice(
  [
    "getSnapshot",
    "subscribe",
    "refreshCatalog",
    "editManualModel",
    "selectPreset",
    "editModelOverrides",
    "saveModelSelection",
    "previewRequest",
    "testChat",
    "getChatCharge",
    "closeChatResult",
    "saveModelDraft",
    "estimateModelCost",
    "changeModelPack",
  ],
  (Base: typeof ServiceClientBase) =>
    class GraphModelsSlice extends Base {
      getSnapshot = () => this.transport.request(graphModelOperations.getSnapshot, undefined);
      subscribe: IGraphAgentService["subscribe"] = (listener) =>
        this.transport.subscribe(graphModelEventChannel, listener);
      refreshCatalog: IGraphAgentService["refreshCatalog"] = (input) =>
        this.transport.request(graphModelOperations.refreshCatalog, input);
      editManualModel: IGraphAgentService["editManualModel"] = (input) =>
        this.transport.request(graphModelOperations.editManualModel, input);
      selectPreset: IGraphAgentService["selectPreset"] = (input) =>
        this.transport.request(graphModelOperations.selectPreset, input);
      editModelOverrides: IGraphAgentService["editModelOverrides"] = (input) =>
        this.transport.request(graphModelOperations.editModelOverrides, input);
      saveModelSelection: IGraphAgentService["saveModelSelection"] = (input) =>
        this.transport.request(graphModelOperations.saveModelSelection, input);
      previewRequest: IGraphAgentService["previewRequest"] = (input) =>
        this.transport.request(graphModelOperations.previewRequest, input);
      getChatCharge: IGraphAgentService["getChatCharge"] = (i) =>
        this.transport.request(getChatChargeOperation, i);
      closeChatResult: IGraphAgentService["closeChatResult"] = (i) =>
        this.transport.request(closeChatResultOperation, i);
      saveModelDraft: IGraphAgentService["saveModelDraft"] = (i) =>
        this.transport.request(graphModelOperations.saveModelDraft, i);
      estimateModelCost: IGraphAgentService["estimateModelCost"] = (i) =>
        this.transport.request(graphModelOperations.estimateModelCost, i);
      changeModelPack: IGraphAgentService["changeModelPack"] = (i) =>
        this.transport.request(graphModelOperations.changeModelPack, i);
      testChat: IGraphAgentService["testChat"] = (input, signal) =>
        this.transport.request(testChatOperation, input, { signal });
    },
);
