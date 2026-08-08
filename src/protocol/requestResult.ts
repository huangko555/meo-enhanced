export type ProtocolErrorCode = 'operation-failed' | 'timeout';

export type ProtocolError = {
  readonly code: ProtocolErrorCode;
  readonly message: string;
};

export type RequestResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeProtocolError(value: unknown): ProtocolError | null {
  if (!isRecord(value)
    || (value.code !== 'operation-failed' && value.code !== 'timeout')
    || typeof value.message !== 'string'
    || value.message.length === 0) {
    return null;
  }
  return { code: value.code, message: value.message };
}

export function decodeRequestResult<T>(
  value: unknown,
  decodeValue: (candidate: unknown) => T | null
): RequestResult<T> | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return null;
  }
  if (value.ok) {
    const decodedValue = decodeValue(value.value);
    return decodedValue === null ? null : { ok: true, value: decodedValue };
  }
  const error = decodeProtocolError(value.error);
  return error === null ? null : { ok: false, error };
}
