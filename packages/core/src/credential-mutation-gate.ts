import { AppError } from "./errors.js";

/** Blocks new provider work before draining existing mutations for a consistent export. */
export class CredentialMutationGate {
  private accepting: boolean;
  private frozen: boolean;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(frozen = false) {
    this.accepting = !frozen;
    this.frozen = frozen;
  }
  assertAvailable(): void {
    if (!this.accepting) throw new AppError("conflict", "凭据已冻结，请先完成共享切换或取消切换");
  }
  assertWritable(): void {
    if (this.frozen) throw new AppError("conflict", "凭据已冻结，请先完成共享切换或取消切换");
  }
  get isFrozen(): boolean {
    return this.frozen;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    const promise = Promise.resolve().then(operation);
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  async freeze(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled([...this.pending]);
    this.frozen = true;
  }
  resume(): void {
    this.frozen = false;
    this.accepting = true;
  }
}
