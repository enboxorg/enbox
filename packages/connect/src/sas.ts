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
import { CryptoUtils, Hkdf, isX25519PrivateJwk, Sha256, X25519 } from '@enbox/crypto';

import { assertX25519PublicJwk } from './envelope.js';

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
const CONNECT_VERIFICATION_GRID_SIZE = 9;

/** Domain separation prefix for the SAS HKDF derivation. */
const CONNECT_SAS_KDF_INFO_PREFIX = 'enbox/connect/v2/sas';

/** Maximum HKDF derivation rounds before aborting (probability of >1 round is < 2^-180). */
const MAX_SAS_DERIVATION_ROUNDS = 16;

/** Curated 64-symbol palette modeled on Matrix MSC1267 (`Emoji_Presentation=Yes` glyphs). */
const RAW_VERIFICATION_SYMBOLS: readonly (readonly [emoji: string, label: string])[] = [
  ['🐶', 'Dog'], ['🐱', 'Cat'], ['🦁', 'Lion'], ['🐴', 'Horse'],
  ['🦄', 'Unicorn'], ['🦊', 'Fox'], ['🐻', 'Bear'], ['🐼', 'Panda'],
  ['🐸', 'Frog'], ['🐙', 'Octopus'], ['🦋', 'Butterfly'], ['🐢', 'Turtle'],
  ['🐳', 'Whale'], ['🦉', 'Owl'], ['🐧', 'Penguin'], ['🐝', 'Bee'],
  ['🍎', 'Apple'], ['🍌', 'Banana'], ['🍉', 'Melon'], ['🍓', 'Berry'],
  ['🥑', 'Avocado'], ['🍕', 'Pizza'], ['🌮', 'Taco'], ['🍩', 'Donut'],
  ['☕', 'Coffee'], ['🍄', 'Mushroom'], ['🌵', 'Cactus'], ['🌻', 'Flower'],
  ['🌲', 'Tree'], ['🌙', 'Moon'], ['⭐', 'Star'], ['⚡', 'Bolt'],
  ['🔥', 'Fire'], ['🌈', 'Rainbow'], ['⛄', 'Snowman'], ['🌊', 'Wave'],
  ['🚀', 'Rocket'], ['⛵', 'Boat'], ['🚲', 'Bike'], ['🚁', 'Helicopter'],
  ['🚂', 'Train'], ['⚓', 'Anchor'], ['🧭', 'Compass'], ['🎈', 'Balloon'],
  ['🎁', 'Gift'], ['🎸', 'Guitar'], ['🎺', 'Trumpet'], ['🔔', 'Bell'],
  ['🔑', 'Key'], ['🔒', 'Lock'], ['💎', 'Gem'], ['👑', 'Crown'],
  ['🎩', 'Hat'], ['👓', 'Glasses'], ['☔', 'Umbrella'], ['⏰', 'Clock'],
  ['💡', 'Bulb'], ['📚', 'Books'], ['🎨', 'Palette'], ['🧩', 'Puzzle'],
  ['🔨', 'Hammer'], ['🧲', 'Magnet'], ['🏆', 'Trophy'], ['🎯', 'Target'],
];

/**
 * Curated 64-symbol verification palette modeled on Matrix MSC1267.
 * Every entry has a unique emoji and unique short 1-word label chosen for
 * cross-platform rendering clarity, colorblind safety, and instant recognition.
 */
export const CONNECT_VERIFICATION_SYMBOLS: readonly ConnectVerificationSymbol[] = Object.freeze(
  RAW_VERIFICATION_SYMBOLS.map(([emoji, label], id): ConnectVerificationSymbol =>
    Object.freeze({ id, emoji, label }),
  ),
);

/** Parameters for {@link deriveConnectVerificationSymbols}. */
export type DeriveConnectVerificationSymbolsParams = {
  /** Local ephemeral X25519 private key (`responsePrivateKey` on app, `walletPrivateKey` on wallet). */
  privateKey: Jwk;
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

/**
 * Encodes SAS transcript fields with unambiguous uint32be length prefixes
 * followed by a fixed uint32be counter so variable-length strings can never
 * collide across field boundaries.
 */
function encodeSasTranscriptInfo(fields: readonly string[], counter: number): Uint8Array {
  const encodedFields = fields.map((field): Uint8Array => Convert.string(field).toUint8Array());
  let totalLength = 4;
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
  requestJwe,
  state,
  nonce,
  responseKey,
  walletEpk,
}: DeriveConnectVerificationSymbolsParams): Promise<
  readonly [ConnectVerificationSymbol, ConnectVerificationSymbol, ConnectVerificationSymbol]
> {
  if (!isX25519PrivateJwk(privateKey)) {
    throw new Error('Connect: private key must be an X25519 OKP JWK.');
  }
  assertX25519PublicJwk(responseKey);
  assertX25519PublicJwk(walletEpk);

  let peerPublicKey: Jwk;
  if (privateKey.x === responseKey.x) {
    peerPublicKey = walletEpk;
  } else if (privateKey.x === walletEpk.x) {
    peerPublicKey = responseKey;
  } else {
    throw new Error('Connect: SAS key pair does not match `responseKey` and `walletEpk`.');
  }

  const sharedSecret = await X25519.sharedSecret({
    privateKeyA : privateKey,
    publicKeyB  : peerPublicKey,
  });

  if (CryptoUtils.isAllZeroBytes(sharedSecret)) {
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

  const chosen: number[] = [];
  for (let counter = 0; counter < MAX_SAS_DERIVATION_ROUNDS && chosen.length < CONNECT_VERIFICATION_SYMBOL_COUNT; counter++) {
    const derived = await Hkdf.deriveKeyBytes({ // NOSONAR: S9382 — counter-mode HKDF rounds stop once 3 distinct symbols are drawn
      baseKeyBytes : sharedSecret,
      hash         : 'SHA-256',
      salt,
      info         : encodeSasTranscriptInfo(transcriptFields, counter),
      length       : 256,
    });
    collectDistinctSymbolIndices(derived, chosen);
  }

  if (chosen.length < CONNECT_VERIFICATION_SYMBOL_COUNT) {
    throw new Error('Connect: failed to derive distinct SAS verification symbols.');
  }

  return Object.freeze([
    CONNECT_VERIFICATION_SYMBOLS[chosen[0]],
    CONNECT_VERIFICATION_SYMBOLS[chosen[1]],
    CONNECT_VERIFICATION_SYMBOLS[chosen[2]],
  ] as const);
}

function collectDistinctSymbolIndices(bytes: Uint8Array, chosen: number[]): void {
  for (const byte of bytes) {
    const index = byte & 0x3f; // 0..63, unbiased because 256 is a multiple of 64.
    if (!chosen.includes(index)) {
      chosen.push(index);
      if (chosen.length === CONNECT_VERIFICATION_SYMBOL_COUNT) {
        return;
      }
    }
  }
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

/** Builds a shuffled 9-tile (3x3) verification grid containing the 3 targets plus 6 random decoys. */
function buildVerificationGrid(
  targets: readonly [ConnectVerificationSymbol, ConnectVerificationSymbol, ConnectVerificationSymbol],
): ConnectVerificationSymbol[] {
  const targetIds = new Set(targets.map((target): number => target.id));
  const decoys = CONNECT_VERIFICATION_SYMBOLS.filter((symbol): boolean => !targetIds.has(symbol.id));
  const picked: ConnectVerificationSymbol[] = [...targets];

  const decoyNeeded = CONNECT_VERIFICATION_GRID_SIZE - CONNECT_VERIFICATION_SYMBOL_COUNT;
  for (let i = 0; i < decoyNeeded; i++) {
    const swapIndex = i + randomInt(decoys.length - i);
    [decoys[i], decoys[swapIndex]] = [decoys[swapIndex], decoys[i]];
    picked.push(decoys[i]);
  }

  // Fisher-Yates shuffle the 9 tiles so target positions are uniform.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }

  return picked;
}

/** Verifies the user's unordered 3-of-9 selection against the derived target symbols. */
function verifyVerificationSelection(
  selectedIds: readonly number[],
  targets: readonly [ConnectVerificationSymbol, ConnectVerificationSymbol, ConnectVerificationSymbol],
): boolean {
  if (selectedIds.length !== CONNECT_VERIFICATION_SYMBOL_COUNT) {
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

  return targets.every((target): boolean => selectedSet.has(target.id));
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
    privateKey  : walletPrivateKey,
    requestJwe,
    state       : request.state,
    nonce       : request.nonce,
    responseKey : request.responseKey,
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
