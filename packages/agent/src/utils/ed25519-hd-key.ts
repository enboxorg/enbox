import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { concatBytes, createView, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

const HARDENED_OFFSET = 0x80000000;
const MASTER_SECRET = utf8ToBytes('ed25519 seed');
const ZERO = new Uint8Array([0]);

type Ed25519HdKeyOptions = {
  chainCode: Uint8Array;
  depth?: number;
  index?: number;
  parentFingerprint?: number;
  privateKey: Uint8Array;
};

function assertBytes(bytes: Uint8Array, length?: number): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Ed25519HdKey: expected Uint8Array');
  }
  if (length !== undefined && bytes.length !== length) {
    throw new RangeError(`Ed25519HdKey: expected ${length} bytes, got ${bytes.length}`);
  }
}

function toU32(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 32 - 1) {
    throw new Error(`Invalid number=${n}. Should be from 0 to 2 ** 32 - 1`);
  }

  const bytes = new Uint8Array(4);
  createView(bytes).setUint32(0, n, false);
  return bytes;
}

function fromU32(bytes: Uint8Array): number {
  return createView(bytes).getUint32(0, false);
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Minimal SLIP-0010 Ed25519 HD key derivation used by {@link HdIdentityVault}.
 */
export class Ed25519HdKey {
  public readonly chainCode: Uint8Array;
  public readonly depth: number;
  public readonly index: number;
  public readonly parentFingerprint: number;
  public readonly privateKey: Uint8Array;

  public static fromMasterSeed(seed: Uint8Array): Ed25519HdKey {
    assertBytes(seed);
    if (8 * seed.length < 128 || 8 * seed.length > 512) {
      throw new Error(
        `Ed25519HdKey: wrong seed length=${seed.length}. Should be between 128 and 512 bits; 256 bits is advised)`
      );
    }

    const digest = hmac(sha512, MASTER_SECRET, seed);
    return new Ed25519HdKey({
      chainCode  : digest.slice(32),
      privateKey : digest.slice(0, 32),
    });
  }

  public constructor({ chainCode, depth = 0, index = 0, parentFingerprint = 0, privateKey }: Ed25519HdKeyOptions) {
    assertBytes(privateKey, 32);
    assertBytes(chainCode, 32);

    if (depth === 0 && (parentFingerprint !== 0 || index !== 0)) {
      throw new Error('Ed25519HdKey: zero depth with non-zero index/parent fingerprint');
    }

    this.chainCode = chainCode;
    this.depth = depth;
    this.index = index;
    this.parentFingerprint = parentFingerprint;
    this.privateKey = privateKey;
  }

  public get publicKeyRaw(): Uint8Array {
    return ed25519.getPublicKey(this.privateKey);
  }

  public get publicKey(): Uint8Array {
    return concatBytes(ZERO, this.publicKeyRaw);
  }

  public get fingerprint(): number {
    return fromU32(hash160(this.publicKey));
  }

  public derive(path: string, forceHardened = false): Ed25519HdKey {
    if (!/^[mM]'?/.test(path)) {
      throw new Error('Path must start with m or M');
    }
    if (/^[mM]'?$/.test(path)) {
      return this;
    }

    const parts = path.replace(/^[mM]'?\//, '').split('/');
    return parts.reduce(
      (parent: Ed25519HdKey, part: string): Ed25519HdKey => parent.deriveChild(Ed25519HdKey.parseChildIndex(part, forceHardened)),
      this
    );
  }

  public deriveChild(index: number): Ed25519HdKey {
    if (index < HARDENED_OFFSET) {
      throw new Error(`Non-hardened child derivation not possible for Ed25519 (index=${index})`);
    }

    const digest = hmac(sha512, this.chainCode, concatBytes(ZERO, this.privateKey, toU32(index)));
    return new Ed25519HdKey({
      chainCode         : digest.slice(32),
      depth             : this.depth + 1,
      index,
      parentFingerprint : this.fingerprint,
      privateKey        : digest.slice(0, 32),
    });
  }

  private static parseChildIndex(part: string, forceHardened: boolean): number {
    const match = /^(\d+)('?)$/.exec(part);
    if (match?.length !== 3) {
      throw new Error(`Invalid child index: ${part}`);
    }

    let index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index >= HARDENED_OFFSET) {
      throw new Error('Invalid index');
    }

    if (forceHardened || match[2] === '\'') {
      index += HARDENED_OFFSET;
    }

    return index;
  }
}
