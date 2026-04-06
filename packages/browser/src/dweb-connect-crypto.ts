/**
 * ECDH + AES-256-GCM encryption for the DWeb Connect postMessage channel.
 *
 * Protects the authorization response (delegate private keys, decryption
 * keys, grants) from same-origin XSS interception. Both the dapp and
 * wallet generate ephemeral P-256 keypairs, exchange public keys during
 * the handshake, derive a shared AES-256-GCM key via ECDH + HKDF, and
 * encrypt/decrypt the payload.
 *
 * P-256 is used (instead of X25519) because `crypto.subtle.deriveKey`
 * with ECDH requires a NIST curve in all major browsers. The keys are
 * ephemeral — generated fresh for each connect session.
 *
 * @module
 */

/** Exported public key as raw bytes (base64url-encoded for postMessage). */
export type ExportedPublicKey = string;

/** Encrypted payload sent via postMessage. */
export interface EncryptedPostMessagePayload {
  /** The encrypted JSON payload as base64url. */
  ciphertext: string;
  /** AES-GCM initialization vector as base64url. */
  iv: string;
  /** The wallet's ephemeral P-256 public key as base64url raw bytes. */
  walletPublicKey: string;
}

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const AES_KEY_PARAMS: AesDerivedKeyParams = { name: 'AES-GCM', length: 256 };
const HKDF_INFO = new TextEncoder().encode('dweb-connect-v1');

/**
 * Generate an ephemeral P-256 ECDH keypair for a single connect session.
 *
 * @returns The keypair and the public key as a base64url-encoded raw export.
 */
export async function generateEphemeralKeyPair(): Promise<{
  keyPair: CryptoKeyPair;
  publicKeyBase64url: ExportedPublicKey;
}> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveKey']);
  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { keyPair, publicKeyBase64url: toBase64url(new Uint8Array(rawPub)) };
}

/**
 * Derive a shared AES-256-GCM key from a local ECDH private key and a
 * remote public key.
 */
async function deriveSharedKey(
  localPrivateKey: CryptoKey,
  remotePublicKeyBase64url: string,
): Promise<CryptoKey> {
  const remotePubRaw = fromBase64url(remotePublicKeyBase64url);
  const remotePublicKey = await crypto.subtle.importKey(
    'raw', remotePubRaw, ECDH_PARAMS, false, [],
  );

  // ECDH → raw shared secret, then HKDF → AES-256-GCM key.
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublicKey } as EcdhKeyDeriveParams,
    localPrivateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, 'HKDF', false, ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hkdfKey,
    AES_KEY_PARAMS,
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a JSON-serializable payload for postMessage transport.
 *
 * Called by the **wallet** side. Uses the wallet's ephemeral private key
 * and the dapp's ephemeral public key to derive the shared AES key.
 *
 * @returns The encrypted payload plus the wallet's public key (for the dapp to derive the same shared key).
 */
export async function encryptPostMessagePayload(
  payload: Record<string, unknown>,
  walletKeyPair: CryptoKeyPair,
  walletPublicKeyBase64url: string,
  dappPublicKeyBase64url: string,
): Promise<EncryptedPostMessagePayload> {
  const sharedKey = await deriveSharedKey(walletKeyPair.privateKey, dappPublicKeyBase64url);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv } as AesGcmParams,
    sharedKey,
    plaintext,
  );

  return {
    ciphertext      : toBase64url(new Uint8Array(ciphertextBuf)),
    iv              : toBase64url(iv),
    walletPublicKey : walletPublicKeyBase64url,
  };
}

/**
 * Decrypt a postMessage payload received from the wallet.
 *
 * Called by the **dapp** side. Uses the dapp's ephemeral private key
 * and the wallet's ephemeral public key to derive the same shared key.
 */
export async function decryptPostMessagePayload(
  encrypted: EncryptedPostMessagePayload,
  dappKeyPair: CryptoKeyPair,
): Promise<Record<string, unknown>> {
  const sharedKey = await deriveSharedKey(dappKeyPair.privateKey, encrypted.walletPublicKey);
  const iv = fromBase64url(encrypted.iv);
  const ciphertext = fromBase64url(encrypted.ciphertext);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv } as AesGcmParams,
    sharedKey,
    ciphertext,
  );

  return JSON.parse(new TextDecoder().decode(plaintextBuf));
}

// ── Base64url helpers ────────────────────────────────────────────

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  let b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  // Strip trailing padding without a backtracking-vulnerable regex.
  while (b64.endsWith('=')) { b64 = b64.slice(0, -1); }
  return b64;
}

function fromBase64url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
