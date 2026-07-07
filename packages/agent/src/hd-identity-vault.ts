import type { Jwk } from '@enbox/crypto';
import type { KeyValueStore } from '@enbox/common';

import type { DidDhtCreateOptions, PortableDid } from '@enbox/dids';

import { wordlist } from '@scure/bip39/wordlists/english.js';
import { BearerDid, DidDht, isPortableDid } from '@enbox/dids';
import { Convert, MemoryStore } from '@enbox/common';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';

import type { JweHeaderParams } from './prototyping/crypto/jose/jwe.js';
import type { IdentityVault, IdentityVaultBackup, IdentityVaultBackupData, IdentityVaultParams, IdentityVaultStatus } from './types/identity-vault.js';

import { AgentCryptoApi } from './crypto-api.js';
import { CompactJwe } from './prototyping/crypto/jose/jwe-compact.js';
import { DeterministicKeyGenerator } from './utils-internal.js';
import { Ed25519HdKey } from './utils/ed25519-hd-key.js';
import { LocalKeyManager } from './local-key-manager.js';

/**
 * Extended initialization parameters for HdIdentityVault, including an optional recovery phrase
 * that can be used to derive keys to encrypt the vault and generate a DID.
 */
export type HdIdentityVaultInitializeParams = {
  /**
    * The password used to secure the vault.
    *
    * The password selected should be strong and securely managed to prevent unauthorized access.
    */
   password: string;

   /**
    * An optional recovery phrase used to derive the cryptographic keys for the vault.
    *
    * Providing a recovery phrase can be used to recover the vault's content or establish a
    * deterministic key generation scheme. If not provided, a new recovery phrase will be generated
    * during the initialization process.
    */
   recoveryPhrase?: string;

   /**
    * Optional dwnEndpoints to register didService endpoints during HdIdentityVault initialization
    *
    * The dwnEndpoints are used to register a DWN endpoint during DidDht.create(). This allows the
    * agent to properly recover connectedDids from DWN. Also, this pattern can be used on the server
    * side in place of the agentDid-->connectedDids pattern.
    */
    dwnEndpoints?: string[];
 };

export type HdIdentityVaultResetPasswordWithRecoveryPhraseParams = {
  /** The BIP-39 recovery phrase originally used to initialize the vault. */
  recoveryPhrase: string;

  /** The new password used to unlock the existing vault from this point forward. */
  password: string;
};

type HdIdentityVaultDerivedMaterial = {
  recoveryPhrase: string;
  contentEncryptionKey: Jwk;
  contentEncryptionKeyJwe: string;
  portableDid: PortableDid;
};

export class HdIdentityVaultRecoveryPhraseMismatchError extends Error {
  public readonly code = 'HD_IDENTITY_VAULT_RECOVERY_PHRASE_MISMATCH';

  constructor(message = 'HdIdentityVault: Recovery phrase does not match the initialized vault.') {
    super(message);
    this.name = 'HdIdentityVaultRecoveryPhraseMismatchError';
  }
}

/**
 * Type guard function to check if a given object is an empty string or a string containing only
 * whitespace.
 *
 * This is an internal utility function used to validate password inputs, ensuring they are not
 * empty or filled with only whitespace characters, which are considered invalid for password
 * purposes.
 *
 * @param obj - The object to be checked, typically expected to be a password string.
 * @returns A boolean value indicating whether the object is an empty string or a string with only
 *          whitespace.
 */
function isEmptyString(obj: unknown): obj is string {
  return typeof obj !== 'string' || obj.trim().length === 0;
}

/**
 * Type guard function to check if a given object conforms to the {@link IdentityVaultBackup}
 * interface.
 *
 * This function is an internal utility meant to ensure the integrity and structure of the data
 * assumed to be an {@link IdentityVaultBackup}. It verifies the presence and types of the
 * `dateCreated`, `size`, and `data` properties, aligning with the expected structure of a backup
 * object in the context of an {@link IdentityVault}.
 *
 * @param obj - The object to be verified against the {@link IdentityVaultBackup} interface.
 * @returns A boolean value indicating whether the object is a valid {@link IdentityVaultBackup}.
 */
function isIdentityVaultBackup(obj: unknown): obj is IdentityVaultBackup {
  return typeof obj === 'object' && obj !== null
    && 'dateCreated' in obj && typeof obj.dateCreated === 'string'
    && 'size' in obj && typeof obj.size === 'number'
    && 'data' in obj && typeof obj.data === 'string';
}

/**
 * Internal-only type guard function that checks if a given object conforms to the
 * {@link IdentityVaultStatus} interface.
 *
 * This function is utilized within the {@link HdIdentityVault} implementation to ensure the
 * integrity of the object representing the vault's status, verifying the presence and types of
 * required properties. It aasserts the presence and correct types of `initialized`, `lastBackup`,
 * and `lastRestore` properties, ensuring they align with the expected structure of an identity
 * vault's status.
 *
 * @param obj - The object to be checked against the {{@link IdentityVaultStatus} interface.
 * @returns A boolean indicating whether the object is an instance of {@link IdentityVaultStatus}.
 */
function isIdentityVaultStatus(obj: unknown): obj is IdentityVaultStatus {
  return typeof obj === 'object' && obj !== null
    && 'initialized' in obj && typeof obj.initialized === 'boolean'
    && 'lastBackup' in obj
    && 'lastRestore' in obj;
}

/**
 * The `HdIdentityVault` class provides secure storage and management of identity data.
 *
 * The `HdIdentityVault` class implements the `IdentityVault` interface, providing secure storage
 * and management of identity data with an added layer of security using Hierarchical Deterministic
 * (HD) key derivation based on the SLIP-0010 standard for Ed25519 keys. It enhances identity
 * protection by generating and securing the identity using a derived HD key, allowing for the
 * deterministic regeneration of keys from a recovery phrase.
 *
 * The vault is capable of:
 * - Secure initialization with a password and an optional recovery phrase, employing HD key
 *   derivation.
 * - Encrypting the identity data using a derived content encryption key (CEK) which is securely
 *   encrypted and stored, accessible only by the correct password.
 * - Securely backing up and restoring the vault’s contents, including the HD-derived keys and
 *   associated DID.
 * - Locking and unlocking the vault, which encrypts and decrypts the CEK for secure access to the
 *   vault's contents.
 * - Managing the DID associated with the identity, providing a secure identity layer for
 *   applications.
 *
 * Usage involves initializing the vault with a secure password (and optionally a recovery phrase),
 * which then allows for the secure storage, backup, and retrieval of the identity data.
 *
 * Note: Ensure the password is strong and securely managed, as it is crucial for the security of the
 * vault's encrypted contents.
 *
 * @example
 * ```typescript
 * const vault = new HdIdentityVault();
 * await vault.initialize({ password: 'secure-unique-phrase', recoveryPhrase: 'twelve words ...' });
 * const backup = await vault.backup();
 * await vault.restore({ backup, password: 'secure-unique-phrase' });
 * ```
 */
export class HdIdentityVault implements IdentityVault<{ InitializeResult: string }> {
  /** Provides cryptographic functions needed for secure storage and management of the vault. */
  public crypto = new AgentCryptoApi();

  /** Determines the computational intensity of the key derivation process. */
  private readonly _keyDerivationWorkFactor: number;

  /** The underlying key-value store for the vault's encrypted content. */
  private readonly _store: KeyValueStore<string, string>;

  /** The cryptographic key used to encrypt and decrypt the vault's content securely. */
  private _contentEncryptionKey: Jwk | undefined;

  /**
   * Cached initialization state. Once read from the store, avoids redundant LevelDB reads on
   * subsequent checks. The `initialized` flag is write-once (false → true) and never reverts,
   * making it safe to cache indefinitely. Mirrors the pattern used by {@link _contentEncryptionKey}
   * for the synchronous {@link isLocked} check.
   */
  private _cachedInitialized: boolean | undefined;

  /**
   * Cached decrypted PortableDid from the last successful {@link getDid} call.
   * Caching the PortableDid (not the BearerDid) avoids the expensive JWE
   * decrypt + LevelDB read on every call, while still returning a fresh
   * BearerDid instance each time so callers cannot mutate shared state.
   */
  private _cachedPortableDid: PortableDid | undefined;

  /**
   * Constructs an instance of `HdIdentityVault`, initializing the key derivation factor and data
   * store. It sets the default key derivation work factor and initializes the internal data store,
   * either with the provided store or a default in-memory store. It also establishes the initial
   * status of the vault as uninitialized and locked.
   *
   * @param params - Optional parameters when constructing a vault instance.
   * @param params.keyDerivationWorkFactor - Optionally set the computational effort for key derivation.
   * @param params.store - Optionally specify a custom key-value store for vault data.
   */
  constructor({ keyDerivationWorkFactor, store }: IdentityVaultParams = {}) {
    this._keyDerivationWorkFactor = keyDerivationWorkFactor ?? 210_000;
    this._store = store ?? new MemoryStore<string, string>();
  }

  /**
   * Creates a backup of the vault's current state, including the encrypted DID and content
   * encryption key, and returns it as an `IdentityVaultBackup` object. The backup includes a
   * Base64Url-encoded string representing the vault's encrypted data, encapsulating the
   * {@link PortableDid}, the content encryption key, and the vault's status.
   *
   * This method ensures that the vault is initialized and unlocked before proceeding with the
   * backup operation.
   *
   * @throws Error if the vault is not initialized or is locked, preventing the backup.
   * @returns A promise that resolves to the `IdentityVaultBackup` object containing the vault's
   *          encrypted backup data.
   */
  public async backup(): Promise<IdentityVaultBackup> {
    // Verify the identity vault has already been initialized and unlocked.
    if (this.isLocked() || await this.isInitialized() === false) {
      throw new Error(
        'HdIdentityVault: Unable to proceed with the backup operation because the identity vault ' +
        'has not been initialized and unlocked. Please ensure the vault is properly initialized ' +
        'with a secure password before attempting to backup its contents.'
      );
    }

    // Encode the encrypted CEK and DID as a single Base64Url string.
    const backupData: IdentityVaultBackupData = {
      did                  : await this.getStoredDid(),
      contentEncryptionKey : await this.getStoredContentEncryptionKey(),
      status               : await this.getStatus()
    };
    const backupDataString = Convert.object(backupData).toBase64Url();

    // Create a backup object containing the encrypted vault contents.
    const backup: IdentityVaultBackup = {
      data        : backupDataString,
      dateCreated : new Date().toISOString(),
      size        : backupDataString.length
    };

    // Update the last backup timestamp in the data store.
    await this.setStatus({ lastBackup: backup.dateCreated });

    return backup;
  }

  /**
   * Changes the password used to secure the vault.
   *
   * This method decrypts the existing content encryption key (CEK) with the old password, then
   * re-encrypts it with the new password, updating the vault's stored encrypted CEK. It ensures
   * that the vault is initialized and unlocks the vault if the password is successfully changed.
   *
   * @param params - Parameters required for changing the vault password.
   * @param params.oldPassword - The current password used to unlock the vault.
   * @param params.newPassword - The new password to replace the existing one.
   * @throws Error if the vault is not initialized or the old password is incorrect.
   * @returns A promise that resolves when the password change is complete.
   */
  public async changePassword({ oldPassword, newPassword }: {
    oldPassword: string;
    newPassword: string;
  }): Promise<void> {
    // Verify the identity vault has already been initialized.
    if (await this.isInitialized() === false) {
      throw new Error(
        'HdIdentityVault: Unable to proceed with the change password operation because the ' +
        'identity vault has not been initialized. Please ensure the vault is properly ' +
        'initialized with a secure password before trying again.'
      );
    }

    // Lock the vault.
    await this.lock();

    // Retrieve the content encryption key (CEK) record as a compact JWE from the data store.
    const cekJwe = await this.getStoredContentEncryptionKey();

    // Decrypt the compact JWE using the given `oldPassword` to verify it is correct.
    let protectedHeader: JweHeaderParams;
    let contentEncryptionKey: Jwk;
    try {
      let contentEncryptionKeyBytes: Uint8Array;
      ({ plaintext: contentEncryptionKeyBytes, protectedHeader } = await CompactJwe.decrypt({
        jwe        : cekJwe,
        key        : Convert.string(oldPassword).toUint8Array(),
        crypto     : this.crypto,
        keyManager : new LocalKeyManager(),
        options    : { minP2cCount: 1 }, // Vault decrypts its own JWEs; no external-input floor needed.
      }));
      contentEncryptionKey = Convert.uint8Array(contentEncryptionKeyBytes).toObject() as Jwk;

    } catch {
      throw new Error(`HdIdentityVault: Unable to change the vault password due to an incorrectly entered old password.`);
    }

    // Re-encrypt the vault content encryption key (CEK) using the new password.
    const newCekJwe = await CompactJwe.encrypt({
      key        : Convert.string(newPassword).toUint8Array(),
      protectedHeader, // Re-use the protected header from the original JWE.
      plaintext  : Convert.object(contentEncryptionKey).toUint8Array(),
      crypto     : this.crypto,
      keyManager : new LocalKeyManager()
    });

    // Update the vault with the new CEK JWE.
    await this._store.set('contentEncryptionKey', newCekJwe);

    // Update the vault CEK in memory, effectively unlocking the vault.
    this._contentEncryptionKey = contentEncryptionKey;
  }

  /**
   * Retrieves the DID (Decentralized Identifier) associated with the vault.
   *
   * This method ensures the vault is initialized and unlocked before decrypting and returning the
   * DID. The DID is stored encrypted and  is decrypted using the vault's content encryption key.
   *
   * @throws Error if the vault is not initialized, is locked, or the DID cannot be decrypted.
   * @returns A promise that resolves with a {@link BearerDid}.
   */
  public async getDid(): Promise<BearerDid> {
    // Verify the identity vault is unlocked.
    if (this.isLocked()) {
      throw new Error(`HdIdentityVault: Vault has not been initialized and unlocked.`);
    }

    // If the decrypted PortableDid is not yet cached, decrypt it from the
    // vault store.  This avoids the expensive LevelDB read + JWE decrypt on
    // every call while the vault is unlocked.
    if (!this._cachedPortableDid) {
      this._cachedPortableDid = await this.decryptStoredPortableDid(this._contentEncryptionKey!);
    }

    // Always return a fresh BearerDid from a deep copy of the cached
    // PortableDid.  BearerDid is mutable (document, metadata, keyManager
    // are public) and BearerDid.import() takes document/metadata by
    // reference, so without the clone a caller mutating a returned DID
    // would corrupt the cache for all subsequent getDid() calls.
    return await BearerDid.import({ portableDid: structuredClone(this._cachedPortableDid) });
  }

  /**
   * Fetches the current status of the `HdIdentityVault`, providing details on whether it's
   * initialized and the timestamps of the last backup and restore operations.
   *
   * @returns A promise that resolves with the current status of the `HdIdentityVault`, detailing
   *          its initialization, lock state, and the timestamps of the last backup and restore.
   */
  public async getStatus(): Promise<IdentityVaultStatus> {
    const storedStatus = await this._store.get('vaultStatus');

    // On the first run, the store will not contain an IdentityVaultStatus object yet, so return an
    // uninitialized status.
    if (!storedStatus) {
      return {
        initialized : false,
        lastBackup  : null,
        lastRestore : null
      };
    }

    const vaultStatus = Convert.string(storedStatus).toObject();
    if (!isIdentityVaultStatus(vaultStatus)) {
      throw new Error('HdIdentityVault: Invalid IdentityVaultStatus object in store');
    }

    // Only cache the `true` state — `initialized` is write-once (false → true) and never reverts,
    // so a cached `true` is always valid. Leaving `false` uncached ensures a subsequent
    // `isInitialized()` call after `initialize()` correctly reads the updated store.
    if (vaultStatus.initialized) {
      this._cachedInitialized = true;
    }

    return vaultStatus;
  }

  /**
   * Initializes the `HdIdentityVault` with a password and an optional recovery phrase.
   *
   * If a recovery phrase is not provided, a new one is generated. This process sets up the vault,
   * deriving the necessary cryptographic keys and preparing the vault for use. It ensures the vault
   * is ready to securely store and manage identity data.
   *
   * @example
   * ```ts
   * const identityVault = new HdIdentityVault();
   * const recoveryPhrase = await identityVault.initialize({
   *   password: 'your-secure-phrase'
   * });
   * console.log('Vault initialized. Recovery phrase:', recoveryPhrase);
   * ```
   *
   * @param params - The initialization parameters.
   * @param params.password - The password used to secure the vault.
   * @param params.recoveryPhrase - An optional 12-word recovery phrase for key derivation. If
   *                                omitted, a new recovery is generated.
   * @returns A promise that resolves with the recovery phrase used during the initialization, which
   *          should be securely stored by the user.
   */
  public async initialize({ password, recoveryPhrase, dwnEndpoints }:
    HdIdentityVaultInitializeParams
  ): Promise<string> {
    // Verify that the identity vault was not previously initialized.
    if (await this.isInitialized()) {
      throw new Error(`HdIdentityVault: Vault has already been initialized.`);
    }

    const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints });

    await this._store.set('contentEncryptionKey', derivedMaterial.contentEncryptionKeyJwe);
    await this._store.set(
      'did',
      await this.encryptPortableDid(derivedMaterial.portableDid, derivedMaterial.contentEncryptionKey)
    );

    this._contentEncryptionKey = derivedMaterial.contentEncryptionKey;
    this._cachedPortableDid = derivedMaterial.portableDid;
    await this.setStatus({ initialized: true });

    // Return the recovery phrase in case it was generated so that it can be displayed to the user
    // for safekeeping.
    return derivedMaterial.recoveryPhrase;
  }

  /**
   * Resets the vault password using the original recovery phrase.
   *
   * The recovery phrase must derive the same vault CEK and agent DID that are already stored in
   * this vault. If it does not, no stored state is changed. On success, only the password-wrapped
   * CEK is replaced; the encrypted DID and all local vault data are preserved.
   */
  public async resetPasswordWithRecoveryPhrase({
    recoveryPhrase,
    password,
  }: HdIdentityVaultResetPasswordWithRecoveryPhraseParams): Promise<void> {
    if (await this.isInitialized() === false) {
      throw new Error(
        'HdIdentityVault: Unable to reset the vault password because the identity vault has not ' +
        'been initialized.'
      );
    }

    const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase });
    let storedPortableDid: PortableDid;
    try {
      storedPortableDid = await this.decryptStoredPortableDid(derivedMaterial.contentEncryptionKey);
    } catch {
      throw new HdIdentityVaultRecoveryPhraseMismatchError();
    }

    if (storedPortableDid.uri !== derivedMaterial.portableDid.uri) {
      throw new HdIdentityVaultRecoveryPhraseMismatchError();
    }

    await this._store.set('contentEncryptionKey', derivedMaterial.contentEncryptionKeyJwe);
    this._contentEncryptionKey = derivedMaterial.contentEncryptionKey;
    this._cachedPortableDid = storedPortableDid;
  }

  /**
   * Determines whether the vault has been initialized.
   *
   * This method checks the vault's current status to determine if it has been
   * initialized. Initialization is a prerequisite for most operations on the vault,
   * ensuring that it is ready for use.
   *
   * @example
   * ```ts
   * const isInitialized = await identityVault.isInitialized();
   * console.log('Is the vault initialized?', isInitialized);
   * ```
   *
   * @returns A promise that resolves to `true` if the vault has been initialized, otherwise `false`.
   */
  public async isInitialized(): Promise<boolean> {
    if (this._cachedInitialized === true) {
      return true;
    }
    return this.getStatus().then(({ initialized }) => initialized);
  }

  /**
   * Checks if the vault is currently locked.
   *
   * This method assesses the vault's current state to determine if it is locked.
   * A locked vault restricts access to its contents, requiring the correct password
   * to unlock and access the stored identity data. The vault must be unlocked to
   * perform operations that access or modify its contents.
   *
   * @example
   * ```ts
   * const isLocked = await identityVault.isLocked();
   * console.log('Is the vault locked?', isLocked);
   * ```
   *
   * @returns `true` if the vault is locked, otherwise `false`.
   */
  public isLocked(): boolean {
    return !this._contentEncryptionKey;
  }

  /**
   * Locks the `HdIdentityVault`, securing its contents by clearing the in-memory encryption key.
   *
   * This method ensures that the vault's sensitive data cannot be accessed without unlocking the
   * vault again with the correct password. It's an essential security feature for safeguarding
   * the vault's contents against unauthorized access.
   *
   * @example
   * ```ts
   * const identityVault = new HdIdentityVault();
   * await identityVault.lock();
   * console.log('Vault is now locked.');
   * ```
   * @throws An error if the identity vault has not been initialized.
   * @returns A promise that resolves when the vault is successfully locked.
   */
  /**
   * Closes the vault's backing store, releasing its resources (e.g. the
   * LevelDB handle). Lock the vault first; after close the vault must not
   * be used until a new instance is created over the same store location.
   */
  public async close(): Promise<void> {
    await this._store.close();
  }

  public async lock(): Promise<void> {
    // Verify the identity vault has already been initialized.
    if (await this.isInitialized() === false) {
      throw new Error(`HdIdentityVault: Lock operation failed. Vault has not been initialized.`);
    }

    // Clear the vault content encryption key (CEK), effectively locking the vault.
    if (this._contentEncryptionKey) {this._contentEncryptionKey.k = '';}
    this._contentEncryptionKey = undefined;
    this._cachedPortableDid = undefined;
  }

  /**
   * Restores the vault's data from a backup object, decrypting and reinitializing the vault's
   * content with the provided backup data.
   *
   * This operation is crucial for data recovery scenarios, allowing users to regain access to their
   * encrypted data using a previously saved backup and their password.
   *
   * @example
   * ```ts
   * const identityVault = new HdIdentityVault();
   * await identityVault.initialize({ password: 'your-secure-phrase' });
   * // Create a backup of the vault's contents.
   * const backup = await identityVault.backup();
   * // Restore the vault with the same password.
   * await identityVault.restore({ backup: backup, password: 'your-secure-phrase' });
   * console.log('Vault restored successfully.');
   * ```
   *
   * @param params - The parameters required for the restore operation.
   * @param params.backup - The backup object containing the encrypted vault data.
   * @param params.password - The password used to encrypt the backup, necessary for decryption.
   * @returns A promise that resolves when the vault has been successfully restored.
   * @throws An error if the backup object is invalid or if the password is incorrect.
   */
  public async restore({ backup, password }: {
    backup: IdentityVaultBackup;
    password: string;
  }): Promise<void> {
    // Validate the backup object.
    if (!isIdentityVaultBackup(backup)) {
      throw new Error(`HdIdentityVault: Restore operation failed due to invalid backup object.`);
    }

    // Temporarily save the status and contents of the data store while attempting to restore the
    // backup so that they are not lost in case the restore operation fails.
    let previousStatus: IdentityVaultStatus;
    let previousContentEncryptionKey: string;
    let previousDid: string;
    try {
      previousDid = await this.getStoredDid();
      previousContentEncryptionKey = await this.getStoredContentEncryptionKey();
      previousStatus = await this.getStatus();
    } catch {
      throw new Error(
        'HdIdentityVault: The restore operation cannot proceed because the existing vault ' +
        'contents are missing or inaccessible. If the problem persists consider re-initializing ' +
        'the vault and retrying the restore.'
      );
    }

    try {
      // Convert the backup data to a JSON object.
      const backupData = Convert.base64Url(backup.data).toObject() as IdentityVaultBackupData;

      // Restore the backup to the data store.
      await this._store.set('did', backupData.did);
      await this._store.set('contentEncryptionKey', backupData.contentEncryptionKey);
      await this.setStatus(backupData.status);

      // Attempt to unlock the vault with the given `password`.
      await this.unlock({ password });

    } catch {
      // If the restore operation fails, revert the data store to the status and contents that were
      // saved before the restore operation was attempted.
      await this.setStatus(previousStatus);
      await this._store.set('contentEncryptionKey', previousContentEncryptionKey);
      await this._store.set('did', previousDid);

      throw new Error(
        'HdIdentityVault: Restore operation failed due to invalid backup data or an incorrect ' +
        'password. Please verify the password is correct for the provided backup and try again.'
      );
    }

    // Update the last restore timestamp in the data store.
    await this.setStatus({ lastRestore: new Date().toISOString() });
  }

  /**
   * Unlocks the vault by decrypting the stored content encryption key (CEK) using the provided
   * password.
   *
   * This method is essential for accessing the vault's encrypted contents, enabling the decryption
   * of stored data and the execution of further operations requiring the vault to be unlocked.
   *
   * @example
   * ```ts
   * const identityVault = new HdIdentityVault();
   * await identityVault.initialize({ password: 'your-initial-phrase' });
   * // Unlock the vault with the correct password before accessing its contents
   * await identityVault.unlock({ password: 'your-initial-phrase' });
   * console.log('Vault unlocked successfully.');
   * ```
   *
   *
   * @param params - The parameters required for the unlock operation.
   * @param params.password - The password used to encrypt the vault's CEK, necessary for
   *                            decryption.
   * @returns A promise that resolves when the vault has been successfully unlocked.
   * @throws An error if the vault has not been initialized or if the provided password is
   *         incorrect.
   */
  public async unlock({ password }: { password: string }): Promise<void> {
    // Verify the vault has been initialized before attempting to unlock.
    if (await this.isInitialized() === false) {
      throw new Error(`HdIdentityVault: Unable to unlock the vault. Vault has not been initialized.`);
    }

    // Lock the vault if not already locked — avoids an unnecessary
    // redundant isInitialized() store read inside lock().
    if (!this.isLocked()) {
      await this.lock();
    }

    // Retrieve the content encryption key (CEK) record as a compact JWE from the data store.
    const cekJwe = await this.getStoredContentEncryptionKey();

    // Decrypt the compact JWE.
    try {
      const { plaintext: contentEncryptionKeyBytes } = await CompactJwe.decrypt({
        jwe        : cekJwe,
        key        : Convert.string(password).toUint8Array(),
        crypto     : this.crypto,
        keyManager : new LocalKeyManager(),
        options    : { minP2cCount: 1 }, // Vault decrypts its own JWEs; no external-input floor needed.
      });
      const contentEncryptionKey = Convert.uint8Array(contentEncryptionKeyBytes).toObject() as Jwk;

      // Save the content encryption key in memory, thereby unlocking the vault.
      this._contentEncryptionKey = contentEncryptionKey;

    } catch {
      throw new Error(`HdIdentityVault: Unable to unlock the vault due to an incorrect password.`);
    }
  }

  /**
   * Encrypts arbitrary data using the vault's content encryption key (CEK).
   *
   * The vault must be unlocked. The returned compact JWE string can be safely
   * stored in untrusted storage (e.g. `localStorage`). Only the vault password
   * can decrypt the data.
   *
   * @param params.plaintext - The data to encrypt.
   * @returns A compact JWE string.
   * @throws If the vault is locked.
   */
  public async encryptData({ plaintext }: { plaintext: Uint8Array }): Promise<string> {
    if (this.isLocked() || !this._contentEncryptionKey) {
      throw new Error('HdIdentityVault: Cannot encrypt data — vault is locked.');
    }

    return CompactJwe.encrypt({
      key             : this._contentEncryptionKey,
      plaintext,
      protectedHeader : { alg: 'dir', enc: 'A256GCM' },
      crypto          : this.crypto,
      keyManager      : new LocalKeyManager(),
    });
  }

  /**
   * Decrypts data that was previously encrypted with {@link encryptData}.
   *
   * The vault must be unlocked.
   *
   * @param params.jwe - The compact JWE string to decrypt.
   * @returns The original plaintext bytes.
   * @throws If the vault is locked or the JWE is invalid.
   */
  public async decryptData({ jwe }: { jwe: string }): Promise<Uint8Array> {
    if (this.isLocked() || !this._contentEncryptionKey) {
      throw new Error('HdIdentityVault: Cannot decrypt data — vault is locked.');
    }

    const { plaintext } = await CompactJwe.decrypt({
      jwe,
      key        : this._contentEncryptionKey,
      crypto     : this.crypto,
      keyManager : new LocalKeyManager(),
      options    : { minP2cCount: 1 },
    });

    return plaintext;
  }

  private async deriveVaultMaterial({
    password,
    recoveryPhrase,
    dwnEndpoints,
  }: HdIdentityVaultInitializeParams): Promise<HdIdentityVaultDerivedMaterial> {
    this.validatePassword(password);
    const resolvedRecoveryPhrase = this.resolveRecoveryPhrase(recoveryPhrase);

    const rootSeed = await mnemonicToSeed(resolvedRecoveryPhrase);
    const rootHdKey = Ed25519HdKey.fromMasterSeed(rootSeed);

    // The vault key is deterministic so the same phrase can re-derive both the CEK and unlock salt.
    const vaultHdKey = rootHdKey.derive(`m/44'/0'/0'/0'/0'`);
    const contentEncryptionKey = await this.crypto.deriveKey({
      algorithm           : 'HKDF-512',
      baseKeyBytes        : vaultHdKey.privateKey,
      salt                : '',
      info                : 'vault_cek',
      derivedKeyAlgorithm : 'A256GCM',
    });
    const saltInput = await this.crypto.deriveKeyBytes({
      algorithm    : 'HKDF-512',
      baseKeyBytes : vaultHdKey.publicKey,
      salt         : '',
      info         : 'vault_unlock_salt',
      length       : 256,
    });

    return {
      recoveryPhrase          : resolvedRecoveryPhrase,
      contentEncryptionKey,
      contentEncryptionKeyJwe : await this.encryptContentEncryptionKey({
        password,
        contentEncryptionKey,
        saltInput,
      }),
      portableDid: await this.derivePortableDid({ rootHdKey, dwnEndpoints }),
    };
  }

  private validatePassword(password: string): void {
    if (isEmptyString(password)) {
      throw new Error(
        'HdIdentityVault: The password is required and cannot be blank. Please provide a ' +
        'valid, non-empty password.'
      );
    }
  }

  private resolveRecoveryPhrase(recoveryPhrase?: string): string {
    if (recoveryPhrase !== undefined && isEmptyString(recoveryPhrase)) {
      throw new Error(
        'HdIdentityVault: The recovery phrase is required and cannot be blank. Please provide a ' +
        'valid BIP-39 recovery phrase.'
      );
    }

    const resolvedRecoveryPhrase = recoveryPhrase ?? generateMnemonic(wordlist, 128);
    if (!validateMnemonic(resolvedRecoveryPhrase, wordlist)) {
      throw new Error(
        'HdIdentityVault: The provided recovery phrase is invalid. Please ensure that the ' +
        'recovery phrase is a correctly formatted series of 12 words.'
      );
    }

    return resolvedRecoveryPhrase;
  }

  private async encryptContentEncryptionKey({
    password,
    contentEncryptionKey,
    saltInput,
  }: {
    password: string;
    contentEncryptionKey: Jwk;
    saltInput: Uint8Array;
  }): Promise<string> {
    const protectedHeader: JweHeaderParams = {
      alg : 'PBES2-HS512+A256KW',
      enc : 'A256GCM',
      cty : 'text/plain',
      p2c : this._keyDerivationWorkFactor,
      p2s : Convert.uint8Array(saltInput).toBase64Url(),
    };

    return CompactJwe.encrypt({
      key        : Convert.string(password).toUint8Array(),
      protectedHeader,
      plaintext  : Convert.object(contentEncryptionKey).toUint8Array(),
      crypto     : this.crypto,
      keyManager : new LocalKeyManager(),
    });
  }

  private async derivePortableDid({
    rootHdKey,
    dwnEndpoints,
  }: {
    rootHdKey: Ed25519HdKey;
    dwnEndpoints?: string[];
  }): Promise<PortableDid> {
    const identityHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/0'`);
    const identityPrivateKey = await this.crypto.bytesToPrivateKey({
      algorithm       : 'Ed25519',
      privateKeyBytes : identityHdKey.privateKey,
    });

    const signingHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/1'`);
    const signingPrivateKey = await this.crypto.bytesToPrivateKey({
      algorithm       : 'Ed25519',
      privateKeyBytes : signingHdKey.privateKey,
    });

    const encryptionHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/2'`);
    const encryptionPrivateKey = await this.crypto.bytesToPrivateKey({
      algorithm       : 'X25519',
      privateKeyBytes : encryptionHdKey.privateKey,
    });

    const deterministicKeyGenerator = new DeterministicKeyGenerator();
    await deterministicKeyGenerator.addPredefinedKeys({
      privateKeys: [identityPrivateKey, signingPrivateKey, encryptionPrivateKey],
    });

    const options = {
      verificationMethods: [
        {
          algorithm : 'Ed25519',
          id        : 'sig',
          purposes  : ['assertionMethod', 'authentication'],
        },
        {
          algorithm : 'X25519',
          id        : 'enc',
          purposes  : ['keyAgreement'],
        },
      ],
    } as DidDhtCreateOptions<DeterministicKeyGenerator>;

    if (dwnEndpoints && dwnEndpoints.length > 0) {
      options.services = [
        {
          id              : 'dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : dwnEndpoints,
        },
      ];
    }

    return (await DidDht.create({ keyManager: deterministicKeyGenerator, options })).export();
  }

  private async encryptPortableDid(portableDid: PortableDid, contentEncryptionKey: Jwk): Promise<string> {
    return CompactJwe.encrypt({
      key             : contentEncryptionKey,
      plaintext       : Convert.object(portableDid).toUint8Array(),
      protectedHeader : { alg: 'dir', enc: 'A256GCM', cty: 'json' },
      crypto          : this.crypto,
      keyManager      : new LocalKeyManager(),
    });
  }

  private async decryptStoredPortableDid(contentEncryptionKey: Jwk): Promise<PortableDid> {
    const { plaintext: portableDidBytes } = await CompactJwe.decrypt({
      jwe        : await this.getStoredDid(),
      key        : contentEncryptionKey,
      crypto     : this.crypto,
      keyManager : new LocalKeyManager(),
      options    : { minP2cCount: 1 },
    });

    const portableDid = Convert.uint8Array(portableDidBytes).toObject();
    if (!isPortableDid(portableDid)) {
      throw new Error('HdIdentityVault: Unable to decode malformed DID in identity vault');
    }

    return portableDid;
  }

  /**
   * Retrieves the Decentralized Identifier (DID) associated with the identity vault from the vault
   * store.
   *
   * This DID is encrypted in compact JWE format and needs to be decrypted after the vault is
   * unlocked. The method is intended to be used internally within the HdIdentityVault class to access
   * the encrypted PortableDid.
   *
   * @returns A promise that resolves to the encrypted DID stored in the vault as a compact JWE.
   * @throws Will throw an error if the DID cannot be retrieved from the vault.
   */
  private async getStoredDid(): Promise<string> {
    // Retrieve the DID record as a compact JWE from the data store.
    const didJwe = await this._store.get('did');

    if (!didJwe) {
      throw new Error(
        'HdIdentityVault: Unable to retrieve the DID record from the vault. Please check the ' +
        'vault status and if the problem persists consider re-initializing the vault and ' +
        'restoring the contents from a previous backup.'
      );
    }

    return didJwe;
  }

  /**
   * Retrieves the encrypted Content Encryption Key (CEK) from the vault's storage.
   *
   * This CEK is used for encrypting and decrypting the vault's contents. It is stored as a
   * compact JWE and should be decrypted with the user's password to be used for further
   * cryptographic operations.
   *
   * @returns A promise that resolves to the stored CEK as a string in compact JWE format.
   * @throws Will throw an error if the CEK cannot be retrieved, indicating potential issues with
   *         the vault's integrity or state.
   */
  private async getStoredContentEncryptionKey(): Promise<string> {
    // Retrieve the content encryption key (CEK) record as a compact JWE from the data store.
    const cekJwe = await this._store.get('contentEncryptionKey');

    if (!cekJwe) {
      throw new Error(
        'HdIdentityVault: Unable to retrieve the Content Encryption Key record from the vault. ' +
        'Please check the vault status and if the problem persists consider re-initializing the ' +
        'vault and restoring the contents from a previous backup.'
      );
    }

    return cekJwe;
  }

  /**
   * Updates the status of the `HdIdentityVault`, reflecting changes in its initialization, lock
   * state, and the timestamps of the last backup and restore operations.
   *
   * This method directly manipulates the internal state stored in the vault's key-value store.
   *
   * @param params - The status properties to be updated.
   * @param params.initialized - Updates the initialization state of the vault.
   * @param params.lastBackup - Updates the timestamp of the last successful backup.
   * @param params.lastRestore - Updates the timestamp of the last successful restore.
   * @returns A promise that resolves to a boolean indicating successful status update.
   * @throws Will throw an error if the status cannot be updated in the key-value store.
   */
  private async setStatus({ initialized, lastBackup, lastRestore }: Partial<IdentityVaultStatus>): Promise<boolean> {
    // Get the current status values from the store, if any.
    const vaultStatus = await this.getStatus();

    // Update the status properties with new values specified, if any.
    vaultStatus.initialized = initialized ?? vaultStatus.initialized;
    vaultStatus.lastBackup = lastBackup ?? vaultStatus.lastBackup;
    vaultStatus.lastRestore = lastRestore ?? vaultStatus.lastRestore;

    // Write the changes to the store.
    await this._store.set('vaultStatus', JSON.stringify(vaultStatus));

    // Update the in-memory cache so subsequent reads skip the store.
    this._cachedInitialized = vaultStatus.initialized;

    return true;
  }
}
