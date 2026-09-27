const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;
const TRAILER_FLAG = 0x80;
const TOKEN_FIELD = 10;
const TOKEN_ID_FIELDS = [1, 10] as const;
const TOKEN_EXPIRY_FIELDS = [3, 30] as const;

type Field =
  | { wireType: typeof WIRE_VARINT; value: number }
  | { wireType: typeof WIRE_FIXED64 | typeof WIRE_FIXED32 | typeof WIRE_LENGTH; bytes: Buffer };

interface TaggedField {
  fieldNumber: number;
  field: Field;
}

export interface GrokResetCreditsSnapshot {
  count: number;
  nextExpiresAt: string | null;
}

function probeFrame(buffer: Buffer, offset: number) {
  if (buffer.length - offset < 5) return null;
  const flag = buffer[offset]!;
  if (flag !== 0 && flag !== 1 && flag !== 0x80 && flag !== 0x81) return null;
  const length = buffer.readUInt32BE(offset + 1);
  const payloadStart = offset + 5;
  if (length > buffer.length - payloadStart) return null;
  return { flag, payloadStart, length };
}

function varint(buffer: Buffer, offset: number): { value: number; next: number } | null {
  let result = 0n;
  let shift = 0n;
  while (offset < buffer.length && shift <= 70n) {
    const byte = buffer[offset++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: Number(result), next: offset };
    shift += 7n;
  }
  return null;
}

function readField(buffer: Buffer, offset: number): { tagged: TaggedField; next: number } | null {
  const tag = varint(buffer, offset);
  if (!tag) return null;
  const fieldNumber = tag.value >>> 3;
  const wireType = tag.value & 7;
  if (!fieldNumber) return null;
  if (wireType === WIRE_VARINT) {
    const value = varint(buffer, tag.next);
    return value
      ? { tagged: { fieldNumber, field: { wireType, value: value.value } }, next: value.next }
      : null;
  }
  const widths = { [WIRE_FIXED64]: 8, [WIRE_FIXED32]: 4 } as Record<number, number>;
  if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
    const width = widths[wireType]!;
    if (tag.next + width > buffer.length) return null;
    return {
      tagged: {
        fieldNumber,
        field: { wireType, bytes: buffer.subarray(tag.next, tag.next + width) },
      },
      next: tag.next + width,
    };
  }
  if (wireType !== WIRE_LENGTH) return null;
  const length = varint(buffer, tag.next);
  if (!length || length.value < 0 || length.next + length.value > buffer.length) return null;
  return {
    tagged: {
      fieldNumber,
      field: {
        wireType,
        bytes: buffer.subarray(length.next, length.next + length.value),
      },
    },
    next: length.next + length.value,
  };
}

function fields(buffer: Buffer): TaggedField[] | null {
  const result: TaggedField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const next = readField(buffer, offset);
    if (!next) return null;
    result.push(next.tagged);
    offset = next.next;
  }
  return result;
}

function timestampSeconds(field: Field): number | null {
  if (field.wireType === WIRE_VARINT) return Number.isFinite(field.value) ? field.value : null;
  if (field.wireType !== WIRE_LENGTH) return null;
  const nested = fields(field.bytes);
  const seconds = nested?.find(
    (entry) => entry.fieldNumber === 1 && entry.field.wireType === WIRE_VARINT,
  );
  return seconds?.field.wireType === WIRE_VARINT ? seconds.field.value : null;
}

function payloadFromFrames(buffer: Buffer): { payload: Buffer | null; status: number | null } {
  let offset = 0;
  let payload: Buffer | null = null;
  let status: number | null = null;
  while (offset < buffer.length) {
    const frame = probeFrame(buffer, offset);
    if (!frame) break;
    const body = buffer.subarray(frame.payloadStart, frame.payloadStart + frame.length);
    if ((frame.flag & TRAILER_FLAG) === 0 && payload === null) payload = body;
    if ((frame.flag & TRAILER_FLAG) !== 0) {
      const match = body.toString("utf8").match(/grpc-status:\s*(\d+)/);
      if (match) status = Number(match[1]);
    }
    offset = frame.payloadStart + frame.length;
  }
  return { payload, status };
}

function inventory(payload: Buffer, nowMs: number): GrokResetCreditsSnapshot | null {
  if (!payload.length) return { count: 0, nextExpiresAt: null };
  const top = fields(payload);
  if (!top) return null;
  const expiries: number[] = [];
  let count = 0;
  for (const token of top) {
    if (token.fieldNumber !== TOKEN_FIELD) continue;
    if (token.field.wireType !== WIRE_LENGTH) return null;
    const nested = fields(token.field.bytes);
    if (!nested) return null;
    const id = nested.find(
      (entry) =>
        TOKEN_ID_FIELDS.includes(entry.fieldNumber as 1 | 10) && entry.field.wireType === WIRE_LENGTH,
    );
    if (!id || id.field.wireType !== WIRE_LENGTH || !id.field.bytes.toString("utf8").trim()) {
      return null;
    }
    const expiry = nested.find((entry) =>
      TOKEN_EXPIRY_FIELDS.includes(entry.fieldNumber as 3 | 30),
    );
    const expiresAt = expiry ? timestampSeconds(expiry.field) : null;
    const expiresMs = expiresAt === null ? null : expiresAt * 1000;
    if (expiresMs !== null && expiresMs < nowMs) continue;
    count += 1;
    if (expiresMs !== null) expiries.push(expiresMs);
  }
  const next = expiries.length ? Math.min(...expiries) : null;
  return { count, nextExpiresAt: next === null ? null : new Date(next).toISOString() };
}

export function decodeGrokResetCreditsFrame(
  buffer: Buffer,
  nowMs = Date.now(),
): GrokResetCreditsSnapshot | null {
  if (!buffer.length) return null;
  try {
    if (!probeFrame(buffer, 0)) return inventory(buffer, nowMs);
    const framed = payloadFromFrames(buffer);
    if (framed.status !== null && framed.status !== 0) return null;
    return framed.payload === null ? null : inventory(framed.payload, nowMs);
  } catch {
    return null;
  }
}
