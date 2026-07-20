export const DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES = 100 * 1024 * 1024;
export const WS_JSON_RPC_ENVELOPE_BYTES = 64 * 1024;

export function base64UrlEncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

export function estimatedWsJsonRpcPayloadBytes(rawDataSize: number): number {
  return base64UrlEncodedLength(rawDataSize) + WS_JSON_RPC_ENVELOPE_BYTES;
}

export function maxWsJsonRpcPayloadBytes(maxRecordDataSize: number): number {
  return estimatedWsJsonRpcPayloadBytes(maxRecordDataSize);
}

/** Byte length of `text` when UTF-8 encoded. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
