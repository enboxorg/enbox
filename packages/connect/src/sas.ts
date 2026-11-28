/**
 * Pre-approval Short Authentication String (SAS) verification for cross-device
 * relay connect handshakes.
 *
 * Instead of encrypting responses under a short, offline-brute-forceable PIN
 * after grants have already been minted, the wallet publishes an ephemeral
 * X25519 handshake public key (`walletEpk`) before the user approves. Both the
 * requesting app and the wallet independently compute the same 3 verification
 * symbols from `X25519(ephemeral, peer)` bound to the full request transcript:
 *
 * - The requesting app displays the 3 symbols (emoji + 1-word label).
 * - The wallet presents a shuffled 3x3 grid (the 3 targets + 6 random decoys)
 *   and verifies the user's unordered 3-of-9 selection locally **before**
 *   minting any DWN grants or sealing a response.
 * - On approval, `walletEpk.x` is bound into the response JWE's `apv` header
 *   so an untrusted relay cannot split-view a different handshake key.
 *
 * @module
 */

import type { ConnectRequest } from './types.js';
import type { Jwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { CryptoUtils, Hkdf, Sha256, X25519 } from '@enbox/crypto';

import { assertX25519PublicJwk, isCanonicalX25519Coordinate } from './envelope.js';

/** A single verification symbol: visually distinct emoji paired with a 1-word label. */
export type ConnectVerificationSymbol = Readonly<{
  /** Stable index in `0..63` within {@link CONNECT_VERIFICATION_SYMBOLS}. */
  id: number;
  /** Cross-platform emoji glyph. */
  emoji: string;
  /** Unambiguous single-word English label (for terminals, screen readers, and colorblind accessibility). */
  label: string;
}>;

/** Number of verification symbols shown on the requesting app and matched in the wallet. */
export const CONNECT_VERIFICATION_SYMBOL_COUNT = 3;

/** Number of tiles in the wallet's shuffled verification grid (3 targets + 6 decoys). */
export const CONNECT_VERIFICATION_GRID_SIZE = 9;

/** Domain separation prefix for the SAS HKDF derivation. */
const CONNECT_SAS_KDF_INFO_PREFIX = 'enbox/connect/v2/sas';

/**
 * Curated 64-symbol verification palette modeled on Matrix MSC1267.
 * Every entry has a unique emoji and unique short 1-word label chosen for
 * cross-platform rendering clarity, colorblind safety, and instant recognition.
 */
export const CONNECT_VERIFICATION_SYMBOLS: readonly ConnectVerificationSymbol[] = Object.freeze([
  Object.freeze({ id: 0, emoji: '🐶', label: 'Dog' }),
  Object.freeze({ id: 1, emoji: '🐱', label: 'Cat' }),
  Object.freeze({ id: 2, emoji: '🦁', label: 'Lion' }),
  Object.freeze({ id: 3, emoji: '🐴', label: 'Horse' }),
  Object.freeze({ id: 4, emoji: '🦄', label: 'Unicorn' }),
  Object.freeze({ id: 5, emoji: '🦊', label: 'Fox' }),
  Object.freeze({ id: 6, emoji: '🐻', label: 'Bear' }),
  Object.freeze({ id: 7, emoji: '🐼', label: 'Panda' }),
  Object.freeze({ id: 8, emoji: '🐸', label: 'Frog' }),
  Object.freeze({ id: 9, emoji: '🐙', label: 'Octopus' }),
  Object.freeze({ id: 10, emoji: '🦋', label: 'Butterfly' }),
  Object.freeze({ id: 11, emoji: '🐢', label: 'Turtle' }),
  Object.freeze({ id: 12, emoji: '🐳', label: 'Whale' }),
  Object.freeze({ id: 13, emoji: '🦉', label: 'Owl' }),
  Object.freeze({ id: 14, emoji: '🐧', label: 'Penguin' }),
  Object.freeze({ id: 15, emoji: '🐝', label: 'Bee' }),
  Object.freeze({ id: 16, emoji: '🍎', label: 'Apple' }),
  Object.freeze({ id: 17, emoji: '🍌', label: 'Banana' }),
  Object.freeze({ id: 18, emoji: '🍉', label: 'Melon' }),
  Object.freeze({ id: 19, emoji: '🍓', label: 'Berry' }),
  Object.freeze({ id: 20, emoji: '🥑', label: 'Avocado' }),
  Object.freeze({ id: 21, emoji: '🍕', label: 'Pizza' }),
  Object.freeze({ id: 22, emoji: '🌮', label: 'Taco' }),
  Object.freeze({ id: 23, emoji: '🍩', label: 'Donut' }),
  Object.freeze({ id: 24, emoji: '☕', label: 'Coffee' }),
  Object.freeze({ id: 25, emoji: '🍄', label: 'Mushroom' }),
  Object.freeze({ id: 26, emoji: '🌵', label: 'Cactus' }),
  Object.freeze({ id: 27, emoji: '🌻', label: 'Flower' }),
  Object.freeze({ id: 28, emoji: '🌲', label: 'Tree' }),
  Object.freeze({ id: 29, emoji: '🌙', label: 'Moon' }),
  Object.freeze({ id: 30, emoji: '⭐', label: 'Star' }),
  Object.freeze({ id: 31, emoji: '⚡', label: 'Bolt' }),
  Object.freeze({ id: 32, emoji: '🔥', label: 'Fire' }),
  Object.freeze({ id: 33, emoji: '🌈', label: 'Rainbow' }),
  Object.freeze({ id: 34, emoji: '⛄', label: 'Snowman' }),
  Object.freeze({ id: 35, emoji: '🌊', label: 'Wave' }),
  Object.freeze({ id: 36, emoji: '🚀', label: 'Rocket' }),
  Object.freeze({ id: 37, emoji: '⛵', label: 'Boat' }),
  Object.freeze({ id: 38, emoji: '🚲', label: 'Bike' }),
  Object.freeze({ id: 39, emoji: '🚁', label: 'Helicopter' }),
  Object.freeze({ id: 40, emoji: '🚂', label: 'Train' }),
  Object.freeze({ id: 41, emoji: '⚓', label: 'Anchor' }),
  Object.freeze({ id: 42, emoji: '🧭', label: 'Compass' }),
  Object.freeze({ id: 43, emoji: '🎈', label: 'Balloon' }),
  Object.freeze({ id: 44, emoji: '🎁', label: 'Gift' }),
  Object.freeze({ id: 45, emoji: '🎸', label: 'Guitar' }),
  Object.freeze({ id: 46, emoji: '🎺', label: 'Trumpet' }),
  Object.freeze({ id: 47, emoji: '🔔', label: 'Bell' }),
  Object.freeze({ id: 48, emoji: '🔑', label: 'Key' }),
  Object.freeze({ id: 49, emoji: '🔒', label: 'Lock' }),
  Object.freeze({ id: 50, emoji: '💎', label: 'Gem' }),
  Object.freeze({ id: 51, emoji: '👑', label: 'Crown' }),
  Object.freeze({ id: 52, emoji: '🎩', label: 'Hat' }),
  Object.freeze({ id: 53, emoji: '👓', label: 'Glasses' }),
  Object.freeze({ id: 54, emoji: '☔', label: 'Umbrella' }),
  Object.freeze({ id: 55, emoji: '⏰', label: 'Clock' }),
  Object.freeze({ id: 56, emoji: '💡', label: 'Bulb' }),
  Object.freeze({ id: 57, emoji: '📚', label: 'Books' }),
  Object.freeze({ id: 58, emoji: '🎨', label: 'Palette' }),
  Object.freeze({ id: 59, emoji: '🧩', label: 'Puzzle' }),
  Object.freeze({ id: 60, emoji: '🔨', label: 'Hammer' }),
  Object.freeze({ id: 61, emoji: '🧲', label: 'Magnet' }),
  Object.freeze({ id: 62, emoji: '🏆', label: 'Trophy' }),
  Object.freeze({ id: 63, emoji: '🎯', label: 'Target' }),
]);

/** Parameters for {@link deriveConnectVerificationSymbols}. */
export type DeriveConnectVerificationSymbolsParams = {
  /** Local ephemeral X25519 private key (`responsePrivateKey` on app, `walletPrivateKey` on wallet). */
  privateKey: Jwk;
  /** Remote party's X25519 public key (`walletEpk` on app, `request.responseKey` on wallet). */
  peerPublicKey: Jwk;
  /** Exact sealed `requestJwe` string fetched from / pushed to the relay. */
  requestJwe: string;
  /** Request `state` correlator. */
  state: string;
  /** Request `nonce` anti-replay token. */
  nonce: string;
  /** App's X25519 public `responseKey` from the connect request. */
  responseKey: Jwk;
  /** Wallet's ephemeral X25519 handshake public key. */
  walletEpk: Jwk;
};

/** Wallet-side pre-approval verification handshake state. */
export type ConnectVerificationHandshake = Readonly<{
  /** Ephemeral X25519 public key to publish via `postRelayHandshake` and bind in response `apv`. */
  walletEpk: Jwk;
  /** The 3 derived verification symbols that the requesting app will display. */
  symbols: readonly [ConnectVerificationSymbol, ConnectVerificationSymbol, ConnectVerificationSymbol];
  /** Shuffled 9-tile (3x3) grid containing the 3 targets plus 6 random decoys. */
  grid: readonly ConnectVerificationSymbol[];
  /** Returns whether the user's unordered selection of tile IDs matches the exact 3 targets. */
  verifySelection: (selectedIds: readonly number[]) => boolean;
}>;

/** Maximum HKDF derivation rounds before aborting (probability of >1 round is < 2^-180). */
const MAX_SAS_DERIVATION_ROUNDS = 16;

/** Asserts that `value` is a private X25519 OKP JWK with canonical 32-byte `d` and `x`. */
function assertX25519PrivateJwk(value: unknown): asserts value is Jwk {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Jwk).kty !== 'OKP'
    || (value as Jwk).crv !== 'X25519'
    || !isCanonicalX25519Coordinate((value as Jwk).d)
    || !isCanonicalX25519Coordinate((value as Jwk).x)
  ) {
    throw new Error('Connect: private key must be an X25519 OKP JWK.');
  }
}

/**
 * Encodes SAS transcript fields with unambiguous uint32be length prefixes
 * followed by a fixed uint32be counter so variable-length strings can never
 * collide across field boundaries.
 */
function encodeSasTranscriptInfo(fields: readonly string[], counter: number): Uint8Array {
  const encodedFields = fields.map((field): Uint8Array => Convert.string(field).toUint8Array());
  let totalLength = 4; // trailing uint32be counter
  for (const bytes of encodedFields) {
    totalLength += 4 + bytes.byteLength;
  }

  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  for (const bytes of encodedFields) {
    view.setUint32(offset, bytes.byteLength, false);
    offset += 4;
    buffer.set(bytes, offset);
    offset += bytes.byteLength;
  }
  view.setUint32(offset, counter, false);
  return buffer;
}

/** Checks that a byte array is not all zeros in constant time. */
function isAllZeroBytes(bytes: Uint8Array): boolean {
  let nonZeroAccumulator = 0;
  for (const byte of bytes) {
    nonZeroAccumulator |= byte;
  }
  return nonZeroAccumulator === 0;
}

/** Appends unique 6-bit indices from `derived` into `chosen` until `targetCount` is reached. */
function collectUniqueIndicesFromBytes(derived: Uint8Array, chosen: number[], targetCount: number): void {
  for (const byte of derived) {
    const index = byte & 0x3f; // 0..63, unbiased because 256 is a multiple of 64.
    if (!chosen.includes(index)) {
      chosen.push(index);
      if (chosen.length === targetCount) {
        return;
      }
    }
  }
}

/** Recursively derives HKDF-SHA256 blocks until `CONNECT_VERIFICATION_SYMBOL_COUNT` distinct indices are collected. */
async function collectDistinctSymbolIndices(
  sharedSecret: Uint8Array,
  salt: Uint8Array,
  transcriptFields: readonly string[],
  chosen: number[] = [],
  counter = 0,
): Promise<readonly number[]> {
  if (chosen.length >= CONNECT_VERIFICATION_SYMBOL_COUNT) {
    return chosen;
  }
  if (counter >= MAX_SAS_DERIVATION_ROUNDS) {
    throw new Error('Connect: failed to derive distinct SAS verification symbols.');
  }
  const info = encodeSasTranscriptInfo(transcriptFields, counter);
  const derived = await Hkdf.deriveKeyBytes({
    baseKeyBytes : sharedSecret,
    hash         : 'SHA-256',
    salt,
    info,
    length       : 256,
  });
  collectUniqueIndicesFromBytes(derived, chosen, CONNECT_VERIFICATION_SYMBOL_COUNT);
  return collectDistinctSymbolIndices(sharedSecret, salt, transcriptFields, chosen, counter + 1);
}

/**
 * Derives 3 distinct verification symbols from the X25519 shared secret between
 * the requesting app's `responseKey` and the wallet's ephemeral `walletEpk`,
 * bound via HKDF-SHA256 to `SHA256(requestJwe)`, `state`, `nonce`, and both
 * public key coordinates.
 *
 * Rejects all-zero X25519 shared secrets (RFC 7748 §6.1) so a low-order peer
 * public key cannot force a predictable SAS.
 */
export async function deriveConnectVerificationSymbols({
  privateKey,
  peerPublicKey,
  requestJwe,
  state,
  nonce,
  responseKey,
  walletEpk,
}: DeriveConnectVerificationSymbolsParams): Promise<
  readonly [ConnectVerificationSymbol, ConnectVerificationSymbol, ConnectVerificationSymbol]
> {
  assertX25519PrivateJwk(privateKey);
  assertX25519PublicJwk(peerPublicKey);
  assertX25519PublicJwk(responseKey);
  assertX25519PublicJwk(walletEpk);

  const isAppSide = privateKey.x === responseKey.x && peerPublicKey.x === walletEpk.x;
  const isWalletSide = privateKey.x === walletEpk.x && peerPublicKey.x === responseKey.x;
  if (!isAppSide && !isWalletSide) {
    throw new Error('Connect: SAS key pair does not match `responseKey` and `walletEpk`.');
  }

  const sharedSecret = await X25519.sharedSecret({
    privateKeyA : privateKey,
    publicKeyB  : peerPublicKey,
  });

  if (isAllZeroBytes(sharedSecret)) {
    throw new Error('Connect: SAS ECDH shared secret must not be all zeros.');
  }

  const salt = await Sha256.digest({ data: Convert.string(requestJwe).toUint8Array() });
  const transcriptFields = [
    CONNECT_SAS_KDF_INFO_PREFIX,
    state,
    nonce,
    responseKey.x as string,
    walletEpk.x as string,
  ];

  const chosen = await collectDistinctSymbolIndices(sharedSecret, salt, transcriptFields);

  return Object.freeze([
    CONNECT_VERIFICATION_SYMBOLS[chosen[0]],
    CONNECT_VERIFICATION_SYMBOLS[chosen[1]],
    CONNECT_VERIFICATION_SYMBOLS[chosen[2]],
  ] as const);
}

/** Unbiased random integer in `[0, max)` using `CryptoUtils.randomBytes`. */
function randomInt(max: number): number {
  const limit = 256 - (256 % max);
  for (;;) {
    const [byte] = CryptoUtils.randomBytes(1);
    if (byte < limit) {
      return byte % max;
    }
  }
}

/**
 * Builds a shuffled 9-tile (3x3) verification grid containing the 3 target
 * symbols plus 6 randomly chosen distinct decoys from the 64-symbol palette.
 */
export function buildVerificationGrid(
  targets: readonly ConnectVerificationSymbol[],
): ConnectVerificationSymbol[] {
  if (targets.length !== CONNECT_VERIFICATION_SYMBOL_COUNT) {
    throw new Error(`Connect: verification grid requires exactly ${CONNECT_VERIFICATION_SYMBOL_COUNT} target symbols.`);
  }

  const targetIds = new Set<number>();
  for (const target of targets) {
    if (
      !Number.isInteger(target.id)
      || target.id < 0
      || target.id >= CONNECT_VERIFICATION_SYMBOLS.length
      || targetIds.has(target.id)
    ) {
      throw new Error('Connect: verification targets must be distinct symbols from the verification palette.');
    }
    targetIds.add(target.id);
  }

  const decoys = CONNECT_VERIFICATION_SYMBOLS.filter((symbol): boolean => !targetIds.has(symbol.id));
  const picked: ConnectVerificationSymbol[] = targets.map((target): ConnectVerificationSymbol =>
    CONNECT_VERIFICATION_SYMBOLS[target.id],
  );

  const decoyNeeded = CONNECT_VERIFICATION_GRID_SIZE - CONNECT_VERIFICATION_SYMBOL_COUNT;
  for (let i = 0; i < decoyNeeded; i++) {
    const swapIndex = i + randomInt(decoys.length - i);
    const chosen = decoys[swapIndex];
    decoys[swapIndex] = decoys[i];
    decoys[i] = chosen;
    picked.push(chosen);
  }

  // Fisher-Yates shuffle the 9 tiles so target positions are uniform.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = picked[i];
    picked[i] = picked[j];
    picked[j] = tmp;
  }

  return picked;
}

/**
 * Verifies the user's unordered 3-of-9 selection against the derived target
 * symbols. Returns `true` iff `selectedIds` contains the exact 3 unique target
 * IDs (in any order).
 */
export function verifyVerificationSelection(
  selectedIds: readonly number[],
  targets: readonly ConnectVerificationSymbol[],
): boolean {
  if (selectedIds.length !== CONNECT_VERIFICATION_SYMBOL_COUNT || targets.length !== CONNECT_VERIFICATION_SYMBOL_COUNT) {
    return false;
  }

  const targetSet = new Set<number>();
  for (const target of targets) {
    if (!Number.isInteger(target.id) || target.id < 0 || target.id >= CONNECT_VERIFICATION_SYMBOLS.length) {
      return false;
    }
    targetSet.add(target.id);
  }
  if (targetSet.size !== CONNECT_VERIFICATION_SYMBOL_COUNT) {
    return false;
  }

  const selectedSet = new Set<number>();
  for (const id of selectedIds) {
    if (!Number.isInteger(id) || id < 0 || id >= CONNECT_VERIFICATION_SYMBOLS.length) {
      return false;
    }
    selectedSet.add(id);
  }
  if (selectedSet.size !== CONNECT_VERIFICATION_SYMBOL_COUNT) {
    return false;
  }

  for (const targetId of targetSet) {
    if (!selectedSet.has(targetId)) {
      return false;
    }
  }
  return true;
}

/**
 * Wallet-side helper: generates a fresh ephemeral X25519 handshake key pair,
 * derives the 3 verification symbols for `request` + `requestJwe`, builds the
 * shuffled 3x3 selection grid, and discards the ephemeral private key once the
 * symbols are computed.
 *
 * `verifySelection` is strictly single-use: once invoked, subsequent calls
 * always return `false` so brute-forcing tiles against one handshake is
 * impossible.
 */
export async function createConnectVerificationHandshake({ request, requestJwe }: {
  request: ConnectRequest;
  requestJwe: string;
}): Promise<ConnectVerificationHandshake> {
  const walletPrivateKey = await X25519.generateKey();
  const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: walletPrivateKey.x };

  const symbols = await deriveConnectVerificationSymbols({
    privateKey    : walletPrivateKey,
    peerPublicKey : request.responseKey,
    requestJwe,
    state         : request.state,
    nonce         : request.nonce,
    responseKey   : request.responseKey,
    walletEpk,
  });

  const grid = Object.freeze(buildVerificationGrid(symbols));
  let attemptConsumed = false;

  return Object.freeze({
    walletEpk,
    symbols,
    grid,
    verifySelection: (selectedIds: readonly number[]): boolean => {
      if (attemptConsumed) {
        return false;
      }
      attemptConsumed = true;
      return verifyVerificationSelection(selectedIds, symbols);
    },
  });
}

/** Formats verification symbols with emoji + word labels (e.g. `🦊 Fox · 🚀 Rocket · 🎸 Guitar`). */
export function formatVerificationSymbols(symbols: readonly ConnectVerificationSymbol[]): string {
  return symbols.map((symbol): string => `${symbol.emoji} ${symbol.label}`).join(' · ');
}

/** Formats verification symbols as plain word labels (e.g. `Fox · Rocket · Guitar`). */
export function formatVerificationLabels(symbols: readonly ConnectVerificationSymbol[]): string {
  return symbols.map((symbol): string => symbol.label).join(' · ');
}
