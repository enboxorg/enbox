/**
 * Utility functions for the Sparse Merkle Tree.
 * Uses SHA-256 from multiformats (already a dependency of dwn-sdk-js).
 */

import type { Hash } from '../types/smt-types.js';

import { sha256 } from 'multiformats/hashes/sha2';

/** The tree depth — one level per bit of a SHA-256 hash. */
export const SMT_DEPTH = 256;

/** A constant zero hash (32 bytes of 0x00). */
export const ZERO_HASH: Hash = new Uint8Array(32);

/**
 * Precomputed default hashes for empty subtrees at each depth.
 *
 * `DEFAULT_HASHES[SMT_DEPTH]` is the hash of an empty leaf (ZERO_HASH).
 * `DEFAULT_HASHES[d]` = H(DEFAULT_HASHES[d+1] || DEFAULT_HASHES[d+1])
 * `DEFAULT_HASHES[0]` is the root hash of a completely empty tree.
 *
 * This array is lazily initialized on first access.
 */
let _defaultHashes: Hash[] | undefined;

export function getDefaultHashes(): Hash[] {
  if (_defaultHashes !== undefined) {
    return _defaultHashes;
  }
  // Build synchronously using the precomputed approach:
  // We can't use async sha256 here, so we'll build it on first async call.
  // For now, return a placeholder — actual initialization happens in initDefaultHashes().
  throw new Error('Default hashes not initialized. Call initDefaultHashes() first.');
}

/**
 * Initialize the default hashes array. Must be called once before using the SMT.
 * This is async because sha256.digest is async.
 */
export async function initDefaultHashes(): Promise<Hash[]> {
  if (_defaultHashes !== undefined) {
    return _defaultHashes;
  }

  const hashes = new Array<Hash>(SMT_DEPTH + 1);
  hashes[SMT_DEPTH] = ZERO_HASH;

  for (let d = SMT_DEPTH - 1; d >= 0; d--) {
    hashes[d] = await hashChildren(hashes[d + 1], hashes[d + 1]);
  }

  _defaultHashes = hashes;
  return _defaultHashes;
}

/**
 * Hash two child hashes together: H(left || right).
 * Uses SHA-256 via multiformats.
 */
export async function hashChildren(left: Hash, right: Hash): Promise<Hash> {
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);

  const digest = await sha256.digest(combined);
  return new Uint8Array(digest.digest);
}

/**
 * Hash a leaf node: H(0x00 || keyHash || valueCid_bytes).
 * The 0x00 prefix distinguishes leaf hashes from internal node hashes,
 * preventing second-preimage attacks.
 */
export async function hashLeaf(keyHash: Hash, valueCid: string): Promise<Hash> {
  const cidBytes = new TextEncoder().encode(valueCid);
  const combined = new Uint8Array(1 + 32 + cidBytes.length);
  combined[0] = 0x00; // leaf domain separator
  combined.set(keyHash, 1);
  combined.set(cidBytes, 33);

  const digest = await sha256.digest(combined);
  return new Uint8Array(digest.digest);
}

/**
 * Compute SHA-256 of a string (used to hash messageCid into the 256-bit key space).
 */
export async function hashKey(key: string): Promise<Hash> {
  const keyBytes = new TextEncoder().encode(key);
  const digest = await sha256.digest(keyBytes);
  return new Uint8Array(digest.digest);
}

/**
 * Extract the bit at a given depth from a 256-bit hash.
 * Depth 0 is the most significant bit of the first byte.
 *
 * @param hash - The 32-byte hash.
 * @param depth - The bit position (0 = MSB of byte 0, 255 = LSB of byte 31).
 * @returns `true` for 1 (right), `false` for 0 (left).
 */
export function getBit(hash: Hash, depth: number): boolean {
  const byteIndex = depth >>> 3; // Math.floor(depth / 8)
  const bitIndex = 7 - (depth & 0x07); // bit position within the byte (MSB-first)
  return ((hash[byteIndex] >>> bitIndex) & 1) === 1;
}

/**
 * Compare two hashes for equality.
 */
export function hashEquals(a: Hash, b: Hash): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Convert a hash to a hex string for use as a store key.
 */
export function hashToHex(hash: Hash): string {
  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a hex string back to a Hash.
 */
export function hexToHash(hex: string): Hash {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
