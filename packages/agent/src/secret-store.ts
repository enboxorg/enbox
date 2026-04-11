import type { KeyValueStore } from '@enbox/common';

import type { IdentityVault } from './types/identity-vault.js';

/**
 * Options for storing a secret.
 */
export type SecretStorePutOptions = {
  /**
   * ISO-8601 timestamp after which the secret is considered expired.
   *
   * Expired secrets are silently deleted on the next {@link SecretStore.get}
   * call and `undefined` is returned.
   */
  expiresAt?: string;
};

/**
 * Platform-agnostic interface for storing classified secrets encrypted at rest
 * by the agent vault.
 *
 * Implementations must ensure that plaintext secret material is never persisted
 * to browser-accessible storage such as `localStorage` or `sessionStorage`.
 */
export interface SecretStore {
  /**
   * Store a secret, encrypted at rest with the vault key.
   *
   * @param key - Unique identifier for the secret.
   * @param value - The secret bytes to store.
   * @param options - Optional metadata (e.g. TTL).
   * @throws If the vault is locked.
   */
  put(key: string, value: Uint8Array, options?: SecretStorePutOptions): Promise<void>;

  /**
   * Retrieve and decrypt a secret.
   *
   * Returns `undefined` if the key does not exist or the secret has expired.
   *
   * @param key - The identifier used when the secret was stored.
   * @throws If the vault is locked.
   */
  get(key: string): Promise<Uint8Array | undefined>;

  /**
   * Delete a secret.
   *
   * @param key - The identifier used when the secret was stored.
   * @returns `true` if the key existed and was removed, `false` otherwise.
   */
  delete(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
//  Internal envelope persisted in the backing KeyValueStore.
// ---------------------------------------------------------------------------

/** @internal */
type SecretEnvelope = {
  /** Compact JWE encrypted by the vault's content encryption key. */
  jwe: string;

  /** Optional ISO-8601 expiry timestamp. */
  expiresAt?: string;
};

// ---------------------------------------------------------------------------
//  VaultBackedSecretStore
// ---------------------------------------------------------------------------

/**
 * Vault-backed implementation of {@link SecretStore}.
 *
 * Secrets are encrypted with the vault's content encryption key (AES-256-GCM
 * via `dir` algorithm) before being persisted to the backing
 * {@link KeyValueStore}. The vault must be unlocked for {@link put} and
 * {@link get} operations; {@link delete} does not require the vault to be
 * unlocked since it only removes the encrypted envelope.
 */
export class VaultBackedSecretStore implements SecretStore {
  private readonly _vault: IdentityVault;
  private readonly _store: KeyValueStore<string, string>;

  constructor({ vault, store }: {
    vault : IdentityVault;
    store : KeyValueStore<string, string>;
  }) {
    this._vault = vault;
    this._store = store;
  }

  public async put(
    key: string,
    value: Uint8Array,
    options?: SecretStorePutOptions,
  ): Promise<void> {
    // vault.encryptData() throws if the vault is locked.
    const jwe = await this._vault.encryptData({ plaintext: value });

    const envelope: SecretEnvelope = { jwe };
    if (options?.expiresAt !== undefined) {
      envelope.expiresAt = options.expiresAt;
    }

    await this._store.set(key, JSON.stringify(envelope));
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    const raw = await this._store.get(key);
    if (raw === undefined) { return undefined; }

    const envelope = JSON.parse(raw) as SecretEnvelope;

    // Purge expired secrets.
    if (envelope.expiresAt !== undefined && new Date(envelope.expiresAt).getTime() <= Date.now()) {
      await this._store.delete(key);
      return undefined;
    }

    // vault.decryptData() throws if the vault is locked.
    return this._vault.decryptData({ jwe: envelope.jwe });
  }

  public async delete(key: string): Promise<boolean> {
    const existing = await this._store.get(key);
    if (existing === undefined) { return false; }
    await this._store.delete(key);
    return true;
  }
}

// ---------------------------------------------------------------------------
//  InMemorySecretStore
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of {@link SecretStore} for testing.
 *
 * Secrets are stored as plain `Uint8Array` values in a `Map` — no encryption,
 * no persistence. This is suitable only for unit tests.
 */
export class InMemorySecretStore implements SecretStore {
  private readonly _store = new Map<string, { value: Uint8Array; expiresAt?: string }>();

  public async put(
    key: string,
    value: Uint8Array,
    options?: SecretStorePutOptions,
  ): Promise<void> {
    this._store.set(key, {
      value     : new Uint8Array(value),
      expiresAt : options?.expiresAt,
    });
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    const entry = this._store.get(key);
    if (entry === undefined) { return undefined; }

    // Purge expired secrets.
    if (entry.expiresAt !== undefined && new Date(entry.expiresAt).getTime() <= Date.now()) {
      this._store.delete(key);
      return undefined;
    }

    return new Uint8Array(entry.value);
  }

  public async delete(key: string): Promise<boolean> {
    return this._store.delete(key);
  }
}
