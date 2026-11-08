export const COMMON_SCHEMA_VERSION = 1 as const;
export type PublicAuthInteraction =
  | "browser-callback"
  | "device-code"
  | "local-import"
  | "secret-form";
