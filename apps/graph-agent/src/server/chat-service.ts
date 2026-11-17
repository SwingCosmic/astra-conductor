import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type {
  BillingEstimate,
  ChatCharge,
  ChatResultRequest,
  TestChatRequest,
  TestChatResult,
  TestChatUsage,
} from "@astra-conductor/contract/graph-agent";
import {
  AppError,
  estimateCharge,
  lookupModelChatCharge,
  type CredentialMutationGate,
  type HttpPort,
  type RefreshCoordinator,
} from "@astra-conductor/core/internal";
import type { GraphModelService } from "./model-service.js";

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
      "readSavedCall" | "watchCall" | "assertContext" | "changed"
    >,
    private readonly credentials: Pick<RefreshCoordinator, "withModelCredential">,
    private readonly http: HttpPort,
    private readonly mutations: CredentialMutationGate,
  ) {}
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
            return call.inference.sendDetailed(
              this.http,
              call.account,
              envelope,
              call.route(envelope),
              call.modelId,
              call.parameters,
              input.prompt,
              deadline,
              call.source,
            );
          },
        );
        deadline.throwIfAborted();
        call.check();
        let estimate: BillingEstimate | null = null;
        if (response.usage && call.entry.rateCard) {
          try {
            estimate = estimateCharge(call.entry.rateCard, {
              meters: measuredMeters(response.usage),
              time: startedAt,
            });
          } catch (error) {
            // Preserve a successful provider reply when its metering cannot be priced.
            if (!(error instanceof Error) || error.name !== "ContractValidationError") throw error;
          }
        }
        const lease = setTimeout(() => this.release(callId), 10 * 60_000);
        lease.unref();
        const result: OpenResult = {
          controller: new AbortController(),
          lease,
          contextId: input.contextId,
          check: call.check,
          receipts: new Map(),
          charge: {
            ...(call.entry.rateCard && {
              rateCard: {
                id: call.entry.rateCard.rateCardId,
                revision: call.entry.rateCard.revision,
              },
            }),
            status: estimate?.status ?? "unknown",
            currency: estimate?.currency ?? null,
            amount: estimate && estimate.status !== "unknown" ? estimate.subtotal : null,
            estimate,
          },
        };
        this.results.set(callId, result);
        if (response.actualCharge) this.applyReceipt(callId, response.actualCharge);
        else if (response.receiptLookup)
          void this.watchReceipt(
            callId,
            response.receiptLookup.generationId,
            call,
            result.controller,
          );
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
  ) {
    const stop = this.models.watchCall(call.check, () => controller.abort());
    try {
      for (let wait = 1000; !controller.signal.aborted; wait = Math.min(wait * 3, 60_000)) {
        await delay(wait, undefined, { signal: controller.signal, ref: false });
        call.check();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        let receipt;
        try {
          receipt = await this.mutations.run(() =>
            this.credentials.withModelCredential(call.account, (envelope) =>
              lookupModelChatCharge(
                this.http,
                call.account,
                envelope,
                call.route(envelope),
                call.modelId,
                generationId,
                signal,
                call.source,
              ),
            ),
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
