import { decode as cborDecode, encode as cborEncode } from 'cborg';

/**
 * CBOR (Concise Binary Object Representation) encoding and decoding utilities.
 *
 * Provides a thin wrapper around the `cborg` library, exposing `encode` and `decode`
 * operations for use by COSE and EAT implementations.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc8949 | RFC 8949 — CBOR}
 */
export class Cbor {
  /**
   * Encodes a JavaScript value to a CBOR byte string.
   *
   * @param value - The value to encode. Supports objects, arrays, strings, numbers,
   *   booleans, null, undefined, Uint8Array (encoded as CBOR byte string), and Map.
   * @returns The CBOR-encoded bytes.
   */
  public static encode(value: unknown): Uint8Array {
    return cborEncode(value);
  }

  /**
   * Decodes a CBOR byte string to a JavaScript value.
   *
   * CBOR maps are decoded as JavaScript `Map` instances to support integer keys,
   * which is required by COSE (RFC 9052) and EAT (RFC 9711).
   *
   * @param data - The CBOR-encoded bytes to decode.
   * @returns The decoded JavaScript value.
   * @throws If the input is not valid CBOR.
   */
  public static decode<T = unknown>(data: Uint8Array): T {
    return cborDecode(data, { useMaps: true }) as T;
  }
}
