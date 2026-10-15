export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type IpcResult<T> = ServiceResult<T>;
