export type AppErrorCode =
  | "authentication"
  | "permission"
  | "network"
  | "rate-limit"
  | "upstream"
  | "storage"
  | "secure-storage"
  | "validation";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PublicErrorDto {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

export function toPublicError(error: unknown): PublicErrorDto {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "upstream",
    message: "Unexpected operation failure",
    retryable: false,
  };
}
