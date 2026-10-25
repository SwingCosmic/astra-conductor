import { ContractValidationError, type PublicError } from "@astra-conductor/polyquota-contract";
import { toPublicError } from "@astra-conductor/core/internal";

export function publicError(error: unknown): PublicError {
  if (error instanceof ContractValidationError)
    return { code: "validation", message: error.message, retryable: false };
  const converted = toPublicError(error);
  return converted.code === "upstream" && converted.message === "Unexpected operation failure"
    ? { code: "internal", message: "操作未能完成", retryable: false }
    : converted;
}

export function errorStatus(
  error: PublicError,
): 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503 {
  switch (error.code) {
    case "validation":
      return 400;
    case "authentication":
      return 401;
    case "permission":
      return 403;
    case "not-found":
      return 404;
    case "conflict":
      return 409;
    case "rate-limit":
      return 429;
    case "desktop-unavailable":
      return 501;
    case "secure-storage":
    case "service-unavailable":
      return 503;
    case "network":
    case "upstream":
      return 502;
    default:
      return 500;
  }
}
