import type { KeyValueStore } from '@enbox/common';
import type { JweHeaderParams, Jwk } from '@enbox/crypto';

import type { DidDhtCreateOptions, DidResolutionResult, DidVerificationMethod, PortableDid } from '@enbox/dids';

import { wordlist } from '@scure/bip39/wordlists/english.js';
import { BearerDid, DidDht, DidErrorCode, utils as didUtils, isPortableDid, setDwnServiceEndpointUrls } from '@enbox/dids';
import { CompactJwe, LocalKeyManager as PortableDidKeyManager } from '@enbox/crypto';
import { Convert, MemoryStore, runWithCrossContextLock } from '@enbox/common';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';

import type {
  IdentityVault,
  IdentityVaultBackup,
  IdentityVaultBackupData,
  IdentityVaultInitializeParams,
  IdentityVaultParams,
  IdentityVaultResetPasswordWithRecoveryPhraseParams,
  IdentityVaultRestoreParams,
  IdentityVaultStatus,
} from './types/identity-vault.js';

import { AgentCryptoApi } from './crypto-api.js';
import { DeterministicKeyGenerator } from './utils-internal.js';
import { Ed25519HdKey } from './utils/ed25519-hd-key.js';
import { LocalKeyManager } from './local-key-manager.js';

/**
 * Extended initialization parameters for HdIdentityVault, including an optional recovery phrase
 * that can be used to derive keys to encrypt the vault and generate a DID.
 */
/** HD vault initialization parameters. */
export type HdIdentityVaultInitializeParams = IdentityVaultInitializeParams;

/** HD vault recovery-password reset parameters. */
export type HdIdentityVaultResetPasswordWithRecoveryPhraseParams =
  IdentityVaultResetPasswordWithRecoveryPhraseParams;

type HdIdentityVaultDerivedMaterial = {
  recoveryPhrase: string;
  contentEncryptionKey: Jwk;
  contentEncryptionKeyJwe: string;
  portableDid: PortableDid;
};

type PreparedVaultDid = {
  portableDid: PortableDid;
  published: boolean;
};

type StoredVaultState = {
  version: 1;
  generation: number;
  did: string;
  contentEncryptionKey: string;
  status: IdentityVaultStatus;
};

const vaultStateKey = 'vaultState';
const vaultStateLockName = '@enbox/agent:hd-identity-vault-state';

function isStoredVaultState(obj: unknown): obj is StoredVaultState {
  return typeof obj === 'object' && obj !== null
    && 'version' in obj && obj.version === 1
    && 'generation' in obj && typeof obj.generation === 'number'
    && Number.isSafeInteger(obj.generation) && obj.generation > 0
    && 'did' in obj && typeof obj.did === 'string' && obj.did.length > 0
    && 'contentEncryptionKey' in obj
    && typeof obj.contentEncryptionKey === 'string' && obj.contentEncryptionKey.length > 0
    && 'status' in obj && isIdentityVaultStatus(obj.status) && obj.status.initialized === true;
}

export class HdIdentityVaultRecoveryPhraseMismatchError extends Error {
  public readonly code = 'HD_IDENTITY_VAULT_RECOVERY_PHRASE_MISMATCH';

  constructor(message = 'HdIdentityVault: Recovery phrase does not match the initialized vault.') {
    super(message);
    this.name = 'HdIdentityVaultRecoveryPhraseMismatchError';
  }
}

/** A DID publication succeeded, but the corresponding local vault generation was not committed. */
export class HdIdentityVaultPartialCommitError extends Error {
  public readonly code = 'HD_IDENTITY_VAULT_PARTIAL_COMMIT';
  public readonly didUri: string;
  public readonly operation: 'initialize' | 'resetPasswordWithRecoveryPhrase' | 'restore';
  public readonly published = true;

  public constructor({ cause, didUri, operation }: {
    cause: unknown;
    didUri: string;
    operation: 'initialize' | 'resetPasswordWithRecoveryPhrase' | 'restore';
  }) {
    super(
      `HdIdentityVault: DID document '${didUri}' was published, but the local vault state ` +
      `could not be committed during ${operation}.`,
      { cause }
    );
    this.name = 'HdIdentityVaultPartialCommitError';
    this.didUri = didUri;
    this.operation = operation;
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
 * Key manager used while reconciling a locally controlled portable DID with its public document.
 * Public-only verification methods remain available for document validation without being exported
 * as private vault key material.
 */
class RecoveredDidKeyManager extends PortableDidKeyManager {
  private readonly _publicKeys = new Map<string, Jwk>();

  public async addPublicKey(key: Jwk): Promise<void> {
    const keyUri = await this.getKeyUri({ key });
    this._publicKeys.set(keyUri, structuredClone(key));
  }

  public override async getPublicKey({ keyUri }: { keyUri: string }): Promise<Jwk> {
    try {
      return await super.getPublicKey({ keyUri });
    } catch (cause: unknown) {
      const publicKey = this._publicKeys.get(keyUri);
      if (publicKey === undefined) {
        throw cause;
      }
      return structuredClone(publicKey);
    }
  }
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

/** Type guard for the decoded contents of an encrypted identity vault backup. */
function isIdentityVaultBackupData(obj: unknown): obj is IdentityVaultBackupData {
  return typeof obj === 'object' && obj !== null
    && 'did' in obj && typeof obj.did === 'string'
    && 'contentEncryptionKey' in obj && typeof obj.contentEncryptionKey === 'string'
    && 'status' in obj && isIdentityVaultStatus(obj.status)
    && obj.status.initialized === true;
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

  /** Generation of the persisted vault state for which the in-memory CEK is valid. */
  private _contentEncryptionKeyGeneration: number | undefined;

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

  /** Generation of the persisted vault state represented by {@link _cachedPortableDid}. */
  private _cachedPortableDidGeneration: number | undefined;

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
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<IdentityVaultBackup> => {
      const state = await this.getStoredVaultState();
      if (state === undefined || this.isLocked()) {
        throw new Error(
          'HdIdentityVault: Unable to proceed with the backup operation because the identity vault ' +
          'has not been initialized and unlocked. Please ensure the vault is properly initialized ' +
          'with a secure password before attempting to backup its contents.'
        );
      }
      this.requireCurrentContentEncryptionKey(state);

      // Encode one immutable generation so concurrent restore/reset operations cannot mix records.
      const backupData: IdentityVaultBackupData = {
        did                  : state.did,
        contentEncryptionKey : state.contentEncryptionKey,
        status               : structuredClone(state.status),
      };
      const backupDataString = Convert.object(backupData).toBase64Url();
      const backup: IdentityVaultBackup = {
        data        : backupDataString,
        dateCreated : new Date().toISOString(),
        size        : backupDataString.length,
      };

      await this.setStoredVaultState({
        ...state,
        status: { ...state.status, lastBackup: backup.dateCreated },
      });
      return backup;
    });
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
    // Reject an invalid replacement before reading, decrypting, clearing, or mutating vault state.
    this.validatePassword(newPassword);

    await runWithCrossContextLock(vaultStateLockName, async (): Promise<void> => {
      const state = await this.getStoredVaultState();
      if (state === undefined) {
        throw new Error(
          'HdIdentityVault: Unable to proceed with the change password operation because the ' +
          'identity vault has not been initialized. Please ensure the vault is properly ' +
          'initialized with a secure password before trying again.'
        );
      }

      this.clearInMemoryVault();

      // Decrypt the compact JWE using the given `oldPassword` to verify it is correct.
      let protectedHeader: JweHeaderParams;
      let contentEncryptionKey: Jwk;
      try {
        let contentEncryptionKeyBytes: Uint8Array;
        ({ plaintext: contentEncryptionKeyBytes, protectedHeader } = await CompactJwe.decrypt({
          jwe        : state.contentEncryptionKey,
          key        : Convert.string(oldPassword).toUint8Array(),
          keyManager : new LocalKeyManager(),
          options    : {
            allowedAlgs : ['PBES2-HS512+A256KW'],
            allowedEncs : ['A256GCM'],
            minP2cCount : 1, // Vault decrypts its own JWEs; no external-input floor needed.
          },
        }));
        contentEncryptionKey = Convert.uint8Array(contentEncryptionKeyBytes).toObject() as Jwk;
      } catch {
        throw new Error(`HdIdentityVault: Unable to change the vault password due to an incorrectly entered old password.`);
      }

      const newCekJwe = await CompactJwe.encrypt({
        key        : Convert.string(newPassword).toUint8Array(),
        protectedHeader,
        plaintext  : Convert.object(contentEncryptionKey).toUint8Array(),
        keyManager : new LocalKeyManager(),
      });

      const nextGeneration = state.generation + 1;
      await this.setStoredVaultState({
        ...state,
        generation           : nextGeneration,
        contentEncryptionKey : newCekJwe,
      });
      this._contentEncryptionKey = contentEncryptionKey;
      this._contentEncryptionKeyGeneration = nextGeneration;
    });
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
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<BearerDid> => {
      const state = await this.getStoredVaultState();
      if (state === undefined || this.isLocked()) {
        throw new Error(`HdIdentityVault: Vault has not been initialized and unlocked.`);
      }
      const contentEncryptionKey = this.requireCurrentContentEncryptionKey(state);

      if (
        this._cachedPortableDid === undefined
        || this._cachedPortableDidGeneration !== state.generation
      ) {
        this._cachedPortableDid = await this.decryptPortableDid({
          jwe: state.did,
          contentEncryptionKey,
        });
        this._cachedPortableDidGeneration = state.generation;
      }

      // Always return a fresh BearerDid from a deep copy of the cached PortableDid. BearerDid is
      // mutable, so without the clone a caller mutating a returned DID would corrupt the cache.
      return this.importRecoveredBearerDid(structuredClone(this._cachedPortableDid));
    });
  }

  /**
   * Fetches the current status of the `HdIdentityVault`, providing details on whether it's
   * initialized and the timestamps of the last backup and restore operations.
   *
   * @returns A promise that resolves with the current status of the `HdIdentityVault`, detailing
   *          its initialization, lock state, and the timestamps of the last backup and restore.
   */
  public async getStatus(): Promise<IdentityVaultStatus> {
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<IdentityVaultStatus> => {
      const state = await this.getStoredVaultState();
      if (state === undefined) {
        return {
          initialized : false,
          lastBackup  : null,
          lastRestore : null,
        };
      }

      this._cachedInitialized = true;
      return structuredClone(state.status);
    });
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
  public async initialize({ password, recoveryPhrase, dwnEndpoints, replaceDwnEndpoints = false }:
    HdIdentityVaultInitializeParams
  ): Promise<string> {
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<string> => {
      if (await this.getStoredVaultState() !== undefined) {
        throw new Error(`HdIdentityVault: Vault has already been initialized.`);
      }

      this.validateEndpointReplacement({ dwnEndpoints, replaceDwnEndpoints });

      const isRecovery = recoveryPhrase !== undefined;
      const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints });
      const preparedDid = isRecovery
        ? await this.resolveOrPublishRecoveredDid({
          portableDid: derivedMaterial.portableDid,
          dwnEndpoints,
          replaceDwnEndpoints,
        })
        : {
          portableDid : await this.publishPortableDid(derivedMaterial.portableDid),
          published   : true,
        };
      const { portableDid } = preparedDid;
      let state: StoredVaultState;
      try {
        state = {
          version              : 1,
          generation           : 1,
          did                  : await this.encryptPortableDid(portableDid, derivedMaterial.contentEncryptionKey),
          contentEncryptionKey : derivedMaterial.contentEncryptionKeyJwe,
          status               : {
            initialized : true,
            lastBackup  : null,
            lastRestore : null,
          },
        };
        await this.setStoredVaultState(state);
      } catch (cause: unknown) {
        if (preparedDid.published) {
          throw new HdIdentityVaultPartialCommitError({
            cause,
            didUri    : portableDid.uri,
            operation : 'initialize',
          });
        }
        throw cause;
      }
      this._contentEncryptionKey = derivedMaterial.contentEncryptionKey;
      this._contentEncryptionKeyGeneration = state.generation;
      this._cachedPortableDid = portableDid;
      this._cachedPortableDidGeneration = state.generation;
      this._cachedInitialized = true;

      return derivedMaterial.recoveryPhrase;
    });
  }

  /**
   * Resets the vault password using the original recovery phrase.
   *
   * The recovery phrase must derive the same vault CEK and agent DID that are already stored in
   * this vault. If it does not, no network or stored state is changed. On success, the DID document
   * is reconciled with resolution before the password-wrapped CEK and encrypted DID are replaced;
   * all other local vault data is preserved.
   */
  public async resetPasswordWithRecoveryPhrase({
    recoveryPhrase,
    password,
    dwnEndpoints,
    replaceDwnEndpoints = false,
  }: HdIdentityVaultResetPasswordWithRecoveryPhraseParams): Promise<void> {
    await runWithCrossContextLock(vaultStateLockName, async (): Promise<void> => {
      const state = await this.getStoredVaultState();
      if (state === undefined) {
        throw new Error(
          'HdIdentityVault: Unable to reset the vault password because the identity vault has not ' +
          'been initialized.'
        );
      }

      this.validateEndpointReplacement({ dwnEndpoints, replaceDwnEndpoints });

      // DID derivation is deliberately offline. The phrase must be proven against the encrypted
      // vault before any resolution or publication is attempted.
      const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase });
      let storedPortableDid: PortableDid;
      try {
        storedPortableDid = await this.decryptPortableDid({
          jwe                  : state.did,
          contentEncryptionKey : derivedMaterial.contentEncryptionKey,
        });
      } catch {
        throw new HdIdentityVaultRecoveryPhraseMismatchError();
      }

      if (storedPortableDid.uri !== derivedMaterial.portableDid.uri) {
        throw new HdIdentityVaultRecoveryPhraseMismatchError();
      }

      const preparedDid = await this.resolveOrPublishRecoveredDid({
        portableDid: storedPortableDid,
        dwnEndpoints,
        replaceDwnEndpoints,
      });
      const { portableDid } = preparedDid;
      const nextGeneration = state.generation + 1;
      try {
        await this.setStoredVaultState({
          ...state,
          generation           : nextGeneration,
          did                  : await this.encryptPortableDid(portableDid, derivedMaterial.contentEncryptionKey),
          contentEncryptionKey : derivedMaterial.contentEncryptionKeyJwe,
        });
      } catch (cause: unknown) {
        if (preparedDid.published) {
          throw new HdIdentityVaultPartialCommitError({
            cause,
            didUri    : portableDid.uri,
            operation : 'resetPasswordWithRecoveryPhrase',
          });
        }
        throw cause;
      }
      this.clearInMemoryVault();
      this._contentEncryptionKey = derivedMaterial.contentEncryptionKey;
      this._contentEncryptionKeyGeneration = nextGeneration;
      this._cachedPortableDid = portableDid;
      this._cachedPortableDidGeneration = nextGeneration;
    });
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

    this.clearInMemoryVault();
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
   * @param params.dwnEndpoints - Endpoints used to bootstrap the restored DID only when it does not
   *                              resolve.
   * @param params.replaceDwnEndpoints - Whether to deliberately replace endpoints in an existing
   *                                     resolved DID document before publishing it.
   * @returns A promise that resolves when the vault has been successfully restored.
   * @throws An error if the backup object is invalid, the password is incorrect, DID resolution
   *         fails, or DID publication fails.
   */
  public async restore({
    backup,
    password,
    dwnEndpoints,
    replaceDwnEndpoints = false,
  }: IdentityVaultRestoreParams): Promise<void> {
    // Validate the backup object.
    if (!isIdentityVaultBackup(backup)) {
      throw new Error(`HdIdentityVault: Restore operation failed due to invalid backup object.`);
    }
    this.validateEndpointReplacement({ dwnEndpoints, replaceDwnEndpoints });

    await runWithCrossContextLock(vaultStateLockName, async (): Promise<void> => {
      let currentState: StoredVaultState | undefined;
      try {
        currentState = await this.getStoredVaultState();
      } catch (cause: unknown) {
        throw new Error(
          'HdIdentityVault: The restore operation cannot proceed because the existing vault ' +
          'contents are missing or inaccessible. If the problem persists consider re-initializing ' +
          'the vault and retrying the restore.',
          { cause }
        );
      }
      if (currentState === undefined) {
        throw new Error(
          'HdIdentityVault: The restore operation cannot proceed because the existing vault ' +
          'contents are missing or inaccessible. If the problem persists consider re-initializing ' +
          'the vault and retrying the restore.'
        );
      }

      let backupData: IdentityVaultBackupData;
      let contentEncryptionKey: Jwk;
      let portableDid: PortableDid;
      try {
        const decodedBackupData = Convert.base64Url(backup.data).toObject();
        if (!isIdentityVaultBackupData(decodedBackupData)) {
          throw new Error('Invalid identity vault backup data.');
        }
        backupData = decodedBackupData;
        contentEncryptionKey = await this.decryptContentEncryptionKey({
          jwe: backupData.contentEncryptionKey,
          password,
        });
        portableDid = await this.decryptPortableDid({
          jwe: backupData.did,
          contentEncryptionKey,
        });
      } catch {
        throw new Error(
          'HdIdentityVault: Restore operation failed due to invalid backup data or an incorrect ' +
          'password. Please verify the password is correct for the provided backup and try again.'
        );
      }

      const preparedDid = await this.resolveOrPublishRecoveredDid({
        portableDid,
        dwnEndpoints,
        replaceDwnEndpoints,
      });
      const reconciledPortableDid = preparedDid.portableDid;
      const restoredStatus: IdentityVaultStatus = {
        ...backupData.status,
        lastRestore: new Date().toISOString(),
      };
      let restoredState: StoredVaultState;
      try {
        restoredState = {
          version              : 1,
          generation           : currentState.generation + 1,
          did                  : await this.encryptPortableDid(reconciledPortableDid, contentEncryptionKey),
          contentEncryptionKey : backupData.contentEncryptionKey,
          status               : restoredStatus,
        };
        await this.setStoredVaultState(restoredState);
      } catch (cause: unknown) {
        if (preparedDid.published) {
          throw new HdIdentityVaultPartialCommitError({
            cause,
            didUri    : reconciledPortableDid.uri,
            operation : 'restore',
          });
        }
        // `vaultState` is one Level/IndexedDB/Map value, so a failed put leaves currentState intact.
        throw new Error('HdIdentityVault: Restore operation failed while committing the restored vault.', { cause });
      }

      this.clearInMemoryVault();
      this._contentEncryptionKey = contentEncryptionKey;
      this._contentEncryptionKeyGeneration = restoredState.generation;
      this._cachedPortableDid = reconciledPortableDid;
      this._cachedPortableDidGeneration = restoredState.generation;
      this._cachedInitialized = true;
    });
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
    await runWithCrossContextLock(vaultStateLockName, async (): Promise<void> => {
      const state = await this.getStoredVaultState();
      if (state === undefined) {
        throw new Error(`HdIdentityVault: Unable to unlock the vault. Vault has not been initialized.`);
      }

      this.clearInMemoryVault();
      try {
        this._contentEncryptionKey = await this.decryptContentEncryptionKey({
          jwe: state.contentEncryptionKey,
          password,
        });
        this._contentEncryptionKeyGeneration = state.generation;
      } catch {
        throw new Error(`HdIdentityVault: Unable to unlock the vault due to an incorrect password.`);
      }
    });
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
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<string> => {
      const state = await this.getStoredVaultState();
      if (state === undefined || this.isLocked()) {
        throw new Error('HdIdentityVault: Cannot encrypt data — vault is locked.');
      }
      const contentEncryptionKey = this.requireCurrentContentEncryptionKey(state);
      return CompactJwe.encrypt({
        key             : contentEncryptionKey,
        plaintext,
        protectedHeader : { alg: 'dir', enc: 'A256GCM' },
        keyManager      : new LocalKeyManager(),
      });
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
    return runWithCrossContextLock(vaultStateLockName, async (): Promise<Uint8Array> => {
      const state = await this.getStoredVaultState();
      if (state === undefined || this.isLocked()) {
        throw new Error('HdIdentityVault: Cannot decrypt data — vault is locked.');
      }
      const contentEncryptionKey = this.requireCurrentContentEncryptionKey(state);
      const { plaintext } = await CompactJwe.decrypt({
        jwe,
        key        : contentEncryptionKey,
        keyManager : new LocalKeyManager(),
        options    : {
          allowedAlgs : ['dir'],
          allowedEncs : ['A256GCM'],
          minP2cCount : 1,
        },
      });

      return plaintext;
    });
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

    let portableDid = await this.derivePortableDid({ rootHdKey });
    if (dwnEndpoints !== undefined) {
      portableDid = this.replacePortableDidDwnEndpoints(portableDid, dwnEndpoints);
    }

    return {
      recoveryPhrase          : resolvedRecoveryPhrase,
      contentEncryptionKey,
      contentEncryptionKeyJwe : await this.encryptContentEncryptionKey({
        password,
        contentEncryptionKey,
        saltInput,
      }),
      portableDid,
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
      keyManager : new LocalKeyManager(),
    });
  }

  private async decryptContentEncryptionKey({ jwe, password }: {
    jwe: string;
    password: string;
  }): Promise<Jwk> {
    const { plaintext } = await CompactJwe.decrypt({
      jwe,
      key        : Convert.string(password).toUint8Array(),
      keyManager : new LocalKeyManager(),
      options    : {
        allowedAlgs : ['PBES2-HS512+A256KW'],
        allowedEncs : ['A256GCM'],
        minP2cCount : 1, // Vault decrypts its own JWEs; no external-input floor needed.
      },
    });

    return Convert.uint8Array(plaintext).toObject() as Jwk;
  }

  private async derivePortableDid({
    rootHdKey,
  }: {
    rootHdKey: Ed25519HdKey;
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
      publish             : false,
      verificationMethods : [
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

    return (await DidDht.create({ keyManager: deterministicKeyGenerator, options })).export();
  }

  private validateEndpointReplacement({ dwnEndpoints, replaceDwnEndpoints }: {
    dwnEndpoints?: string[];
    replaceDwnEndpoints: boolean;
  }): void {
    if (replaceDwnEndpoints && dwnEndpoints === undefined) {
      throw new TypeError(
        'HdIdentityVault: dwnEndpoints must be provided when replaceDwnEndpoints is true.'
      );
    }
  }

  /**
   * Resolve an existing deterministic vault DID before deciding whether to publish anything.
   * Resolution is authoritative unless the caller explicitly requested an endpoint replacement.
   */
  private async resolveOrPublishRecoveredDid({
    portableDid,
    dwnEndpoints,
    replaceDwnEndpoints,
  }: {
    portableDid: PortableDid;
    dwnEndpoints?: string[];
    replaceDwnEndpoints: boolean;
  }): Promise<PreparedVaultDid> {
    const resolutionResult = await this.resolveDidForRecovery(portableDid.uri);

    if (resolutionResult.didResolutionMetadata.error === DidErrorCode.NotFound) {
      const didToPublish = dwnEndpoints !== undefined
        ? this.replacePortableDidDwnEndpoints(portableDid, dwnEndpoints)
        : portableDid;
      return {
        portableDid : await this.publishPortableDid(didToPublish),
        published   : true,
      };
    }

    if (
      resolutionResult.didResolutionMetadata.error !== undefined
      || resolutionResult.didDocument === null
    ) {
      const resolutionError = resolutionResult.didResolutionMetadata.error ?? 'missingDocument';
      throw new Error(
        `HdIdentityVault: Unable to recover DID '${portableDid.uri}' because DID resolution failed: ${resolutionError}.`
      );
    }

    let resolvedPortableDid: PortableDid = {
      ...portableDid,
      document : structuredClone(resolutionResult.didDocument),
      metadata : structuredClone(resolutionResult.didDocumentMetadata),
    };

    if (replaceDwnEndpoints) {
      resolvedPortableDid = this.replacePortableDidDwnEndpoints(resolvedPortableDid, dwnEndpoints!);
      return {
        portableDid : await this.publishPortableDid(resolvedPortableDid),
        published   : true,
      };
    }

    // Validate that the recovered document can be used with the recovered vault key material before
    // committing any vault state.
    await this.importRecoveredBearerDid(resolvedPortableDid);
    return { portableDid: resolvedPortableDid, published: false };
  }

  private async resolveDidForRecovery(didUri: string): Promise<DidResolutionResult> {
    try {
      return await DidDht.resolve(didUri);
    } catch (cause: unknown) {
      throw new Error(
        `HdIdentityVault: Unable to recover DID '${didUri}' because DID resolution failed.`,
        { cause }
      );
    }
  }

  private replacePortableDidDwnEndpoints(portableDid: PortableDid, dwnEndpoints: string[]): PortableDid {
    return {
      ...portableDid,
      document: setDwnServiceEndpointUrls({
        didDocument : portableDid.document,
        endpoints   : dwnEndpoints,
      }),
    };
  }

  private async publishPortableDid(portableDid: PortableDid): Promise<PortableDid> {
    const bearerDid = await this.importRecoveredBearerDid(portableDid);
    const registrationResult = await DidDht.publish({ did: bearerDid });
    if (
      registrationResult.didDocumentMetadata.published !== true
      || registrationResult.didDocument === null
    ) {
      throw new Error(`HdIdentityVault: Failed to publish DID document: ${portableDid.uri}`);
    }

    return {
      ...portableDid,
      document : structuredClone(registrationResult.didDocument),
      metadata : structuredClone(registrationResult.didDocumentMetadata),
    };
  }

  private async importRecoveredBearerDid(portableDid: PortableDid): Promise<BearerDid> {
    const keyManager = new RecoveredDidKeyManager();
    for (const privateKey of portableDid.privateKeys ?? []) {
      await keyManager.importKey({ key: privateKey });
    }

    const verificationMethods = didUtils.getVerificationMethods({ didDocument: portableDid.document });
    for (const verificationMethod of verificationMethods) {
      if (verificationMethod.publicKeyJwk !== undefined) {
        const keyUri = await keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk });
        const isControlled = await keyManager.getPublicKey({ keyUri }).then(() => true).catch(() => false);
        if (!isControlled) {
          await keyManager.addPublicKey(verificationMethod.publicKeyJwk);
        }
      }
    }

    const bearerDid = await BearerDid.import({ portableDid, keyManager });
    const identityVerificationMethod = verificationMethods.find(
      verificationMethod => didUtils.extractDidFragment(verificationMethod.id) === '0'
    );
    if (identityVerificationMethod?.publicKeyJwk === undefined) {
      throw new Error(
        `HdIdentityVault: Recovered DID '${portableDid.uri}' does not contain its identity verification method.`
      );
    }

    await this.requirePrivateVerificationMethod({
      keyManager,
      portableDid,
      verificationMethod : identityVerificationMethod,
      purpose            : 'identity',
    });

    for (const relationship of ['assertionMethod', 'keyAgreement'] as const) {
      const reference = portableDid.document[relationship]?.[0];
      const verificationMethod = typeof reference === 'string'
        ? verificationMethods.find(
          method => didUtils.extractDidFragment(method.id) === didUtils.extractDidFragment(reference)
        )
        : reference;
      if (verificationMethod === undefined) {
        throw new Error(
          `HdIdentityVault: Recovered DID '${portableDid.uri}' does not contain a default ${relationship} verification method.`
        );
      }
      await this.requirePrivateVerificationMethod({
        keyManager,
        portableDid,
        verificationMethod,
        purpose: relationship,
      });
    }

    return bearerDid;
  }

  private async requirePrivateVerificationMethod({
    keyManager,
    portableDid,
    verificationMethod,
    purpose,
  }: {
    keyManager: RecoveredDidKeyManager;
    portableDid: PortableDid;
    verificationMethod: DidVerificationMethod;
    purpose: string;
  }): Promise<void> {
    if (verificationMethod.publicKeyJwk === undefined) {
      throw new Error(
        `HdIdentityVault: Recovered DID '${portableDid.uri}' has no public JWK for its ${purpose} verification method.`
      );
    }

    try {
      const keyUri = await keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk });
      const privateKey = await keyManager.exportKey({ keyUri });
      if (typeof privateKey.d === 'string') {
        return;
      }
    } catch (cause: unknown) {
      throw new Error(
        `HdIdentityVault: Recovered vault key material does not control the ${purpose} key for DID '${portableDid.uri}'.`,
        { cause }
      );
    }

    throw new Error(
      `HdIdentityVault: Recovered vault key material does not control the ${purpose} key for DID '${portableDid.uri}'.`
    );
  }

  private async encryptPortableDid(portableDid: PortableDid, contentEncryptionKey: Jwk): Promise<string> {
    return CompactJwe.encrypt({
      key             : contentEncryptionKey,
      plaintext       : Convert.object(portableDid).toUint8Array(),
      protectedHeader : { alg: 'dir', enc: 'A256GCM', cty: 'json' },
      keyManager      : new LocalKeyManager(),
    });
  }

  private async decryptPortableDid({ jwe, contentEncryptionKey }: {
    jwe: string;
    contentEncryptionKey: Jwk;
  }): Promise<PortableDid> {
    const { plaintext: portableDidBytes } = await CompactJwe.decrypt({
      jwe,
      key        : contentEncryptionKey,
      keyManager : new LocalKeyManager(),
      options    : {
        allowedAlgs : ['dir'],
        allowedEncs : ['A256GCM'],
        minP2cCount : 1,
      },
    });

    const portableDid = Convert.uint8Array(portableDidBytes).toObject();
    if (!isPortableDid(portableDid)) {
      throw new Error('HdIdentityVault: Unable to decode malformed DID in identity vault');
    }

    return portableDid;
  }

  /** Read the atomic state envelope, migrating the legacy three-record layout when encountered. */
  private async getStoredVaultState(): Promise<StoredVaultState | undefined> {
    const serializedState = await this._store.get(vaultStateKey);
    if (serializedState !== undefined) {
      const state = Convert.string(serializedState).toObject();
      if (!isStoredVaultState(state)) {
        throw new Error('HdIdentityVault: Invalid vault state object in store.');
      }
      return state;
    }

    const [did, contentEncryptionKey, serializedStatus] = await Promise.all([
      this._store.get('did'),
      this._store.get('contentEncryptionKey'),
      this._store.get('vaultStatus'),
    ]);
    if (did === undefined && contentEncryptionKey === undefined && serializedStatus === undefined) {
      return undefined;
    }

    if (serializedStatus === undefined) {
      throw new Error('HdIdentityVault: Invalid IdentityVaultStatus object in store.');
    }
    const status = Convert.string(serializedStatus).toObject();
    if (!isIdentityVaultStatus(status)) {
      throw new Error('HdIdentityVault: Invalid IdentityVaultStatus object in store.');
    }
    if (!status.initialized) {
      if (did === undefined && contentEncryptionKey === undefined) {
        return undefined;
      }
      throw new Error('HdIdentityVault: Invalid uninitialized vault contents in store.');
    }
    if (did === undefined) {
      throw new Error(
        'HdIdentityVault: Unable to retrieve the DID record from the vault. Please check the ' +
        'vault status and if the problem persists consider re-initializing the vault and ' +
        'restoring the contents from a previous backup.'
      );
    }
    if (contentEncryptionKey === undefined) {
      throw new Error(
        'HdIdentityVault: Unable to retrieve the Content Encryption Key record from the vault. ' +
        'Please check the vault status and if the problem persists consider re-initializing the ' +
        'vault and restoring the contents from a previous backup.'
      );
    }

    const migratedState: StoredVaultState = {
      version    : 1,
      generation : 1,
      did,
      contentEncryptionKey,
      status,
    };
    await this._store.set(vaultStateKey, JSON.stringify(migratedState));

    // Once the complete legacy state is durably represented by one value, stale split records are
    // no longer authoritative and can be removed independently without risking the new state.
    await Promise.allSettled([
      this._store.delete('did'),
      this._store.delete('contentEncryptionKey'),
      this._store.delete('vaultStatus'),
    ]);
    return migratedState;
  }

  /** Atomically commit one complete vault generation. */
  private async setStoredVaultState(state: StoredVaultState): Promise<void> {
    await this._store.set(vaultStateKey, JSON.stringify(state));
  }

  private requireCurrentContentEncryptionKey(state: StoredVaultState): Jwk {
    if (
      this._contentEncryptionKey === undefined
      || this._contentEncryptionKeyGeneration !== state.generation
    ) {
      this.clearInMemoryVault();
      throw new Error(
        'HdIdentityVault: Vault contents changed in another context. Unlock the vault again.'
      );
    }
    return this._contentEncryptionKey;
  }

  private clearInMemoryVault(): void {
    if (this._contentEncryptionKey !== undefined) {
      this._contentEncryptionKey.k = '';
    }
    this._contentEncryptionKey = undefined;
    this._contentEncryptionKeyGeneration = undefined;
    this._cachedPortableDid = undefined;
    this._cachedPortableDidGeneration = undefined;
  }
}
