import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  modelEndpointDescriptor,
  type BillingEstimate,
  type ChatCharge,
  type ChatResultRequest,
  type ModelRoute,
  type TestChatRequest,
  type TestChatResult,
  type TestChatUsage,
} from "@astra-conductor/contract/graph-agent";
import {
  AppError,
  applyAsyncPolicyChain,
  estimateCharge,
  measuredReply,
  modelAuthorization,
  resolveEffectiveModelRule,
  sendModelChatDetailed,
  validateNativeBody,
  type ActualChargeReceipt,
  type ModelChatResult,
  type CredentialMutationGate,
  type HttpPort,
  type ReceiptContext,
  type RefreshCoordinator,
  type RequestPlan,
} from "@astra-conductor/core/internal";
import type { GraphModelService } from "./model-service.js";
import { nativeDestination, transferNative, type NativeInput } from "./native-proxy.js";

interface Receipt {
  amount: string;
  currency: string;
  eventId?: string;
  source?: string;
  lineId?: string;
  kind?: "cumulative" | "event";
}
interface OpenResult {
  contextId: string;
  controller: AbortController;
  lease: NodeJS.Timeout;
  check: () => void;
  charge: ChatCharge;
  receipts: Map<string, Receipt>;
}
function measuredMeters(usage: TestChatUsage): Record<string, number> {
  const meters: Record<string, number> = { requests: 1 };
  for (const [k, v] of Object.entries(usage))
    if (typeof v === "number") meters[k === "cacheReadTokens" ? "cachedInputTokens" : k] = v;
  return meters;
}
function sumAmounts(events: Receipt[]): string {
  const precision = Math.max(0, ...events.map((e) => e.amount.split(".")[1]?.length ?? 0));
  let units = 0n;
  for (const { amount } of events) {
    const [whole, fraction = ""] = amount.split(".");
    units += BigInt(whole + fraction.padEnd(precision, "0"));
  }
  const digits = units.toString().padStart(precision + 1, "0");
  if (!precision) return digits;
  const decimals = digits.slice(-precision).replace(/0+$/, "");
  return digits.slice(0, -precision) + (decimals ? "." + decimals : "");
}
export class GraphChatService {
  private readonly results = new Map<string, OpenResult>();
  private release(id: string) {
    const r = this.results.get(id);
    if (r) {
      clearTimeout(r.lease);
      r.controller.abort();
      this.results.delete(id);
    }
  }

  constructor(
    private readonly models: Pick<
      GraphModelService,
      "readSavedCall" | "readFamilyDirectory" | "watchCall" | "assertContext" | "changed"
    >,
    private readonly credentials: Pick<RefreshCoordinator, "withModelCredential">,
    private readonly http: HttpPort,
    private readonly mutations: CredentialMutationGate,
  ) {}
  private openResult(
    callId: string,
    contextId: string,
    call: ReturnType<GraphModelService["readSavedCall"]>,
    controller: AbortController,
  ) {
    const lease = setTimeout(() => this.release(callId), 10 * 60_000);
    lease.unref();
    const result: OpenResult = {
      controller,
      lease,
      contextId,
      check: call.check,
      receipts: new Map(),
      charge: {
        status: "unknown",
        amount: null,
        currency: null,
        estimate: null,
        ...(call.entry.rateCard && {
          rateCard: { id: call.entry.rateCard.rateCardId, revision: call.entry.rateCard.revision },
        }),
      },
    };
    this.results.set(callId, result);
    return result;
  }
  private finishResult(
    callId: string,
    startedAt: string,
    call: ReturnType<GraphModelService["readSavedCall"]>,
    response: ModelChatResult,
    rawResponse?: unknown,
  ) {
    const result = this.results.get(callId);
    if (!result) return;
    let estimate: BillingEstimate | null = null;
    if (response.usage && call.entry.rateCard) {
      try {
        estimate = estimateCharge(call.entry.rateCard, {
          meters: measuredMeters(response.usage),
          time: startedAt,
        });
      } catch {
        // Incomplete or unpriceable metering must not interrupt a successful response.
      }
    }
    result.charge = {
      ...result.charge,
      estimate,
      ...(result.charge.status !== "actual" && {
        status: estimate?.status ?? "unknown",
        currency: estimate?.currency ?? null,
        amount: estimate && estimate.status !== "unknown" ? estimate.subtotal : null,
      }),
    };
    if (response.actualCharge) this.applyReceipt(callId, response.actualCharge);
    else if (
      response.responseId &&
      result.charge.status !== "actual" &&
      call.receiptPolicies.length
    )
      void this.watchReceipt(callId, response.responseId, call, result.controller, rawResponse);
  }
  proxy(
    input: NativeInput,
    headers: Headers,
    signal: AbortSignal,
    track: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<Response> {
    let open!: (response: Response) => void, fail!: (err: unknown) => void;
    const ready = new Promise<Response>((ok, bad) => {
      open = ok;
      fail = bad;
    });
    const cancel = new AbortController();
    const deadline = AbortSignal.any([cancel.signal, signal, AbortSignal.timeout(120_000)]);
    const work = track(() =>
      this.mutations.run(async () => {
        const chat = "protocol" in input ? this.models.readSavedCall(input) : undefined;
        const binding = "family" in input ? this.models.readFamilyDirectory(input) : chat!;
        if ("protocol" in input && chat!.entry.selection.protocol !== input.protocol)
          throw new AppError("conflict", "请求入口与已保存的模型协议不符");

        const prepareRoute = (
          route: ModelRoute,
        ): { plan?: RequestPlan; ruleHeaders?: Record<string, string>; url: URL } => {
          if (!route.familyBindingRevision)
            throw new AppError("conflict", "该协议族的接入配置有冲突，请先核实族根地址");
          const version = headers.get("anthropic-version");
          if (
            version &&
            (route.protocol !== "anthropic-messages" ||
              version !== (route.protocolVersion ?? "2023-06-01"))
          )
            throw new AppError("validation", "协议版本与当前绑定不符");
          if (chat && "body" in input) {
            const plan = chat.compilePlan(route);
            validateNativeBody(input.body, plan, route.protocol);
            const { rule } = resolveEffectiveModelRule(chat.modelId, route.requestRule);
            const url = nativeDestination(
              input,
              binding.account,
              route,
              modelEndpointDescriptor(route.protocol).relativePath,
              binding.policy,
              binding.source,
            );
            return { plan, ruleHeaders: rule?.headers, url };
          }
          const url = nativeDestination(
            input,
            binding.account,
            route,
            undefined,
            binding.policy,
            binding.source,
          );
          return { url };
        };

        // For local custom providers and built-in offerings, compile Step 1+2 and validate Step 4c
        // ONCE before touching credentials so invalid bodies fail with zero credential reads.
        const prevalidated = chat?.localRoute ? prepareRoute(chat.localRoute) : undefined;

        const id = chat ? randomUUID() : undefined;
        const startedAt = new Date().toISOString();
        let published = false;
        const unwatch = this.models.watchCall(chat?.checkSelection ?? binding.check, (err) =>
          cancel.abort(err),
        );
        if (chat && id) this.openResult(id, input.contextId, chat, cancel);
        try {
          await this.credentials.withModelCredential(binding.account, async (envelope) => {
            deadline.throwIfAborted();
            binding.check();
            const route = binding.route(envelope);
            const prepared = prevalidated ?? prepareRoute(route);
            const metering: ModelChatResult = { text: "" };
            let rawResponse: unknown;
            await transferNative(input, {
              http: this.http,
              account: binding.account,
              envelope,
              route,
              policy: binding.policy,
              source: binding.source,
              url: prepared.url,
              ruleHeaders: prepared.ruleHeaders,
              modelId: prepared.plan?.upstreamModelId,
              signal: deadline,
              requestSignal: signal,
              callId: id,
              check: binding.check,
              open: (response) => {
                published = true;
                open(response);
              },
              abort: () => cancel.abort(),
              observe: (value) => {
                if (!chat || !id || !value || typeof value !== "object") return;
                const event = value as Record<string, unknown>;
                const data =
                  event.type === "message_start" ? event.message : (event.response ?? value);
                rawResponse = data;
                const measured = measuredReply("", data, route, {
                  providerId: binding.account.provider,
                  offeringId: binding.account.offeringId,
                  policies: [binding.policy],
                });
                if (measured.usage) metering.usage = { ...metering.usage, ...measured.usage };
                if (measured.responseId) metering.responseId = measured.responseId;
                if (measured.actualCharge) this.applyReceipt(id, measured.actualCharge);
              },
              finish: () => {
                if (chat && id) this.finishResult(id, startedAt, chat, metering, rawResponse);
              },
            });
          });
        } catch (err) {
          if (!published && id) this.release(id);
          if (deadline.aborted && deadline.reason instanceof AppError) throw deadline.reason;
          throw err;
        } finally {
          unwatch();
        }
      }),
    );
    void work.catch(fail);
    return ready;
  }
  async testChat(input: TestChatRequest, signal: AbortSignal): Promise<TestChatResult> {
    const cancellation = new AbortController(),
      deadline = AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(120_000)]);
    return this.mutations.run(async () => {
      const call = this.models.readSavedCall(input),
        callId = randomUUID(),
        startedAt = new Date().toISOString(),
        stop = this.models.watchCall(call.check, (error) => cancellation.abort(error));
      try {
        const response = await this.credentials.withModelCredential(
          call.account,
          async (envelope) => {
            call.check();
            deadline.throwIfAborted();
            const route = call.route(envelope);
            if (route.requestRule) call.compilePlan(route);
            return sendModelChatDetailed(
              this.http,
              call.account,
              envelope,
              route,
              call.modelId,
              call.parameters,
              input.prompt,
              deadline,
              call.source,
              {
                facts: call.facts,
                policy: call.policy,
                catalogModels: call.catalogModels,
              },
            );
          },
        );
        deadline.throwIfAborted();
        call.check();
        const result = this.openResult(callId, input.contextId, call, new AbortController());
        this.finishResult(callId, startedAt, call, response);
        return { callId, text: response.text, usage: response.usage, charge: result.charge };
      } catch (err) {
        if (cancellation.signal.aborted) throw cancellation.signal.reason;
        throw err;
      } finally {
        stop();
      }
    });
  }
  private async watchReceipt(
    callId: string,
    generationId: string,
    call: ReturnType<GraphModelService["readSavedCall"]>,
    controller: AbortController,
    rawResponse?: unknown,
  ) {
    const stop = this.models.watchCall(call.check, () => controller.abort());
    try {
      for (let wait = 1000; !controller.signal.aborted; wait = Math.min(wait * 3, 60_000)) {
        await delay(wait, undefined, { signal: controller.signal, ref: false });
        call.check();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        let receipt: ActualChargeReceipt | null = null;
        let attempted = false;
        const trackedHttp: HttpPort = {
          fetch: (...args) => {
            attempted = true;
            return this.http.fetch(...args);
          },
        };
        try {
          receipt = await this.mutations.run(() =>
            this.credentials.withModelCredential(call.account, async (envelope) => {
              const route = call.route(envelope);
              const headers = modelAuthorization(
                call.account,
                envelope,
                route,
                call.modelId,
                "chat",
                call.source,
                call.policy,
              );
              const found = await applyAsyncPolicyChain<ActualChargeReceipt | null, ReceiptContext>(
                null,
                {
                  http: trackedHttp,
                  account: call.account,
                  envelope,
                  route,
                  modelId: call.modelId,
                  rawResponse,
                  generationId,
                  signal,
                  headers,
                },
                call.receiptPolicies.map((p) => p.transformReceipt),
              );
              if (
                found?.eventId &&
                Object.values(envelope.secrets).some(
                  (secret) =>
                    typeof secret === "string" && secret && found.eventId!.includes(secret),
                )
              ) {
                delete found.eventId;
              }
              return found;
            }),
          );
        } catch (e) {
          if (e instanceof AppError && ["network", "rate-limit", "upstream"].includes(e.code))
            continue;
          return;
        }
        if (receipt && !controller.signal.aborted) {
          this.applyReceipt(callId, receipt);
          return;
        }
        if (!attempted) return;
      }
    } catch {
      /* A closed result, revoked route or stopped host releases this optional lookup. */
    } finally {
      stop();
    }
  }
  // Trusted provider callbacks may reconcile a later receipt only while its result remains open.
  applyReceipt(callId: string, receipt: Receipt): void {
    const result = this.results.get(callId);
    if (
      !result ||
      !/^\d{1,32}(?:\.\d{1,32})?$/.test(receipt.amount) ||
      !/^[A-Z]{3}$/.test(receipt.currency)
    )
      return;
    try {
      result.check();
    } catch {
      this.release(callId);
      return;
    }
    const key = JSON.stringify([
      receipt.source ?? "upstream",
      receipt.lineId ?? "total",
      receipt.kind === "cumulative" ? "snapshot" : (receipt.eventId ?? "snapshot"),
    ]);
    const old = result.receipts.get(key);
    if (old?.amount === receipt.amount && old.currency === receipt.currency) return;
    if ([...result.receipts.values()].some((r) => r.currency !== receipt.currency)) return;
    result.receipts.set(key, receipt);
    result.charge = {
      ...result.charge,
      status: "actual",
      amount: sumAmounts([...result.receipts.values()]),
      currency: receipt.currency,
      estimate: result.charge.estimate,
    };
    this.models.changed("charge");
  }
  getCharge(input: ChatResultRequest): ChatCharge {
    this.models.assertContext(input);
    const r = this.results.get(input.callId);
    if (!r || r.contextId !== input.contextId)
      throw new AppError("not-found", "本轮测试结果已关闭");
    r.check();
    r.lease.refresh();
    return r.charge;
  }
  closeResult(input: ChatResultRequest): void {
    this.models.assertContext(input);
    const r = this.results.get(input.callId);
    if (r?.contextId === input.contextId) this.release(input.callId);
  }
  stop() {
    for (const id of this.results.keys()) this.release(id);
  }
}
