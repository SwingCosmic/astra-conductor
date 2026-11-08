import { inject, provide, type InjectionKey } from "vue";
import type {
  ICredentialManagementService,
  IProviderService,
} from "@astra-conductor/contract/common";

export const providerServiceKey: InjectionKey<IProviderService> = Symbol("providerService");
export const credentialServiceKey: InjectionKey<ICredentialManagementService> =
  Symbol("credentialService");
export const providerUiOptionsKey: InjectionKey<{ sessionPrefix: string }> =
  Symbol("providerUiOptions");

export function provideProviderService(service: IProviderService): void {
  provide(providerServiceKey, service);
}

export function provideCredentialService(service: ICredentialManagementService): void {
  provide(credentialServiceKey, service);
}

export function useProviderService(): IProviderService {
  const service = inject(providerServiceKey);
  if (!service) throw new Error("Provider service was not provided");
  return service;
}

export function useCredentialService(): ICredentialManagementService {
  const service = inject(credentialServiceKey);
  if (!service) throw new Error("Credential service was not provided");
  return service;
}

export function useProviderUiOptions(): { sessionPrefix: string } {
  return inject(providerUiOptionsKey, { sessionPrefix: "polyquota" });
}
