export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  fields?: { path: string; code: string; message: string }[];
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type IpcResult<T> = ServiceResult<T>;
