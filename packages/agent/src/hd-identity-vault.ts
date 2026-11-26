import type { KeyValueStore } from '@enbox/common';
import type { JweHeaderParams, Jwk } from '@enbox/crypto';

import type { DidDhtCreateOptions, DidDocument, DidRegistrationResult, DidResolutionResult, DidResolver, PortableDid } from '@enbox/dids';

import { CompactJwe } from '@enbox/crypto';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { BearerDid, DidDht, DidErrorCode, getDwnEndpointStatus, isPortableDid, replaceDwnServiceEndpointUrls } from '@enbox/dids';
import { Convert, MemoryStore } from '@enbox/common';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';

import type { IdentityVault, IdentityVaultBackup, IdentityVaultBackupData, IdentityVaultParams, IdentityVaultStatus, VaultDerivationVersion } from './types/identity-vault.js';

import { AgentCryptoApi } from './crypto-api.js';
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

   /** Retain the generated phrase and required registration policy until owner setup completes. @internal */
   pendingSetup?: { registrationRequired: boolean };

   /** Explicit endpoints for a new DID or recovery without an existing usable public route. */
    dwnEndpoints?: string[];

    /** Leave new recovery endpoints unpublished until the caller prepares their remote tenancy. */
    deferDwnEndpointBootstrap?: boolean;

   /**
    * HD derivation scheme to use. Defaults to `2` for a fresh vault and to automatic
    * `v2 → v1` fallback for recovery. Providing a value forces that exact scheme.
    */
   derivationVersion?: VaultDerivationVersion;

 };

export type HdIdentityVaultResetPasswordWithRecoveryPhraseParams = {
  /** The BIP-39 recovery phrase originally used to initialize the vault. */
  recoveryPhrase: string;

  /** The new password used to unlock the existing vault from this point forward. */
  password: string;

  /** Explicit replacement endpoints for the recovered DID document. */
  dwnEndpoints?: string[];

};

type HdIdentityVaultResetPasswordInternalParams =
  HdIdentityVaultResetPasswordWithRecoveryPhraseParams & {
    /** Preserve a usable existing route until coordinated recovery finishes. */
    deferDwnEndpointReplacement?: boolean;
    /** Leave new recovery endpoints unpublished until the caller prepares their remote tenancy. */
    deferDwnEndpointBootstrap?: boolean;
  };

type HdIdentityVaultDidResolver = Pick<DidResolver, 'resolve'> & {
  refreshResolution?: (didUri: string) => Promise<DidResolutionResult>;
  cacheResolution?: (didUri: string, result: DidResolutionResult) => Promise<void>;
  pinResolution?: (didUri: string, fallback: DidResolutionResult) => Promise<void>;
  publish?: (params: { did: BearerDid }) => Promise<DidRegistrationResult>;
};

type HdIdentityVaultDerivedMaterial = {
  recoveryPhrase: string;
  contentEncryptionKey: Jwk;
  contentEncryptionKeyJwe: string;
  portableDid: PortableDid;
};

/** Setup material belongs only in the encrypted vault record, never public DID metadata. */
type PendingVaultSetup = { recoveryPhrase: string; registrationRequired: boolean };
type StoredVaultDid = PortableDid & { pendingSetup?: PendingVaultSetup };

type HdIdentityVaultReconcileRecoveredDidParams = {
  portableDid: PortableDid;
  replacementEndpoints?: string[];
  deferReplacement?: boolean;
  deferBootstrap?: boolean;
  useStoredOnNotFound?: boolean;
  /** Already-fetched resolution for `portableDid.uri`, to avoid a duplicate DHT lookup. */
  resolution?: DidResolutionResult;
};

type VaultDerivationPaths = {
  vault: string;
  identity: string;
  signing: string;
  encryption: string;
};

/**
 * Derivation paths per scheme. `v1` and `v2` share the same HKDF inputs for the CEK and unlock
 * salt; only these paths differ.
 */
const VAULT_DERIVATION_PATHS: Record<VaultDerivationVersion, VaultDerivationPaths> = {
  1: {
    vault      : `m/44'/0'/0'/0'/0'`,
    identity   : `m/44'/0'/1708523827'/0'/0'`,
    signing    : `m/44'/0'/1708523827'/0'/1'`,
    encryption : `m/44'/0'/1708523827'/0'/2'`,
  },
  2: {
    vault      : `m/43'/1708523827'/0'/0'`,
    identity   : `m/43'/1708523827'/1'/0'/0'`,
    signing    : `m/43'/1708523827'/1'/0'/1'`,
    encryption : `m/43'/1708523827'/1'/0'/2'`,
  },
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
  const hasRequiredFields = typeof obj === 'object' && obj !== null
    && 'initialized' in obj && typeof obj.initialized === 'boolean'
    && 'lastBackup' in obj
    && 'lastRestore' in obj;
  if (!hasRequiredFields) {
    return false;
  }

  // Absent `derivationVersion` represents a legacy `v1` vault.
  if (!('derivationVersion' in obj) || obj.derivationVersion === undefined) {
    return true;
  }

  return obj.derivationVersion === 1 || obj.derivationVersion === 2;
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
  private _cachedPortableDid: StoredVaultDid | undefined;

  /** Resolver supplied by the owning agent so recovery refreshes its normal cache. */
  private _didResolver: HdIdentityVaultDidResolver = DidDht;

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

  public set didResolver(resolver: HdIdentityVaultDidResolver) {
    this._didResolver = resolver;
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

    // Re-encrypt the vault content encryption key (CEK) using the new password.
    const newCekJwe = await CompactJwe.encrypt({
      key        : Convert.string(newPassword).toUint8Array(),
      protectedHeader, // Re-use the protected header from the original JWE.
      plaintext  : Convert.object(contentEncryptionKey).toUint8Array(),
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
    // Always return a fresh BearerDid from a deep copy of the cached
    // PortableDid.  BearerDid is mutable (document, metadata, keyManager
    // are public) and BearerDid.import() takes document/metadata by
    // reference, so without the clone a caller mutating a returned DID
    // would corrupt the cache for all subsequent getDid() calls.
    const portableDid = structuredClone(await this.getCachedPortableDid());
    delete portableDid.pendingSetup;
    return await BearerDid.import({ portableDid });
  }

  /** Read durable unfinished setup while unlocked, under the caller's native vault lifecycle lock. @internal */
  public async getPendingSetup(): Promise<PendingVaultSetup | undefined> {
    const pendingSetup = (await this.getCachedPortableDid(true)).pendingSetup;
    return pendingSetup === undefined ? undefined : {
      recoveryPhrase       : pendingSetup.recoveryPhrase,
      registrationRequired : pendingSetup.registrationRequired,
    };
  }

  /** Retire setup after session persistence; the caller must serialize native vault mutations. @internal */
  public async clearPendingSetup(): Promise<void> {
    const cachedDid = await this.getCachedPortableDid(true);
    if (cachedDid.pendingSetup === undefined) {
      return;
    }
    const portableDid = { ...cachedDid };
    delete portableDid.pendingSetup;
    await this._store.set('did', await this.encryptPortableDid(portableDid, this._contentEncryptionKey!));
    this._cachedPortableDid = portableDid;
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
  public async initialize({
    password,
    recoveryPhrase,
    pendingSetup,
    dwnEndpoints,
    deferDwnEndpointBootstrap = false,
    derivationVersion,
  }: HdIdentityVaultInitializeParams): Promise<string> {
    // Verify that the identity vault was not previously initialized.
    if (await this.isInitialized()) {
      throw new Error(`HdIdentityVault: Vault has already been initialized.`);
    }
    if (pendingSetup !== undefined && (pendingSetup === null || typeof pendingSetup !== 'object'
      || typeof pendingSetup.registrationRequired !== 'boolean')) {
      throw new TypeError('HdIdentityVault: Pending setup requires a boolean registration policy.');
    }
    this.validatePassword(password);
    if (recoveryPhrase !== undefined) {
      this.validateRecoveryPhrase(recoveryPhrase);
    }
    this.validateDerivationVersion(derivationVersion);

    const isRecovery = recoveryPhrase !== undefined;
    let derivedMaterial: HdIdentityVaultDerivedMaterial;
    let portableDid: StoredVaultDid;
    let resolvedVersion: VaultDerivationVersion;
    if (isRecovery) {
      ({ derivedMaterial, portableDid, resolvedVersion } = await this.recoverVaultMaterial({
        password,
        recoveryPhrase,
        dwnEndpoints,
        derivationVersion,
        deferDwnEndpointBootstrap,
      }));
    } else {
      resolvedVersion = derivationVersion ?? 2;
      derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints, derivationVersion: resolvedVersion });
      portableDid = await this.publishPortableDid(derivedMaterial.portableDid);
    }

    if (pendingSetup !== undefined && !isRecovery) {
      portableDid.pendingSetup = {
        recoveryPhrase       : derivedMaterial.recoveryPhrase,
        registrationRequired : pendingSetup.registrationRequired,
      };
    }

    await this._store.set('contentEncryptionKey', derivedMaterial.contentEncryptionKeyJwe);
    await this._store.set(
      'did',
      await this.encryptPortableDid(portableDid, derivedMaterial.contentEncryptionKey)
    );

    this._contentEncryptionKey = derivedMaterial.contentEncryptionKey;
    this._cachedPortableDid = portableDid;
    await this.setStatus({ initialized: true, derivationVersion: resolvedVersion });

    // Return the recovery phrase in case it was generated so that it can be displayed to the user
    // for safekeeping.
    return derivedMaterial.recoveryPhrase;
  }

  /**
   * Resets the vault password using the original recovery phrase.
   *
   * The recovery phrase must derive the same vault CEK and agent DID that are already stored in
   * this vault. If it does not, no stored state is changed. A direct reset without endpoint
   * migration only replaces the password-wrapped CEK and requires no network access.
   */
  public async resetPasswordWithRecoveryPhrase({
    recoveryPhrase,
    password,
    dwnEndpoints,
    deferDwnEndpointReplacement = false,
    deferDwnEndpointBootstrap = false,
  }: HdIdentityVaultResetPasswordInternalParams): Promise<void> {
    if (await this.isInitialized() === false) {
      throw new Error(
        'HdIdentityVault: Unable to reset the vault password because the identity vault has not ' +
        'been initialized.'
      );
    }

    const status = await this.getStatus();
    const version: VaultDerivationVersion = status.derivationVersion ?? 1;
    const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase, derivationVersion: version });
    let storedPortableDid: PortableDid;
    try {
      storedPortableDid = await this.decryptStoredPortableDid(derivedMaterial.contentEncryptionKey);
    } catch {
      throw new HdIdentityVaultRecoveryPhraseMismatchError();
    }

    if (storedPortableDid.uri !== derivedMaterial.portableDid.uri) {
      throw new HdIdentityVaultRecoveryPhraseMismatchError();
    }

    if (dwnEndpoints !== undefined || deferDwnEndpointReplacement) {
      storedPortableDid = await this.reconcileRecoveredDid({
        portableDid          : storedPortableDid,
        replacementEndpoints : dwnEndpoints,
        deferReplacement     : deferDwnEndpointReplacement,
        deferBootstrap       : deferDwnEndpointBootstrap,
        useStoredOnNotFound  : true,
      });
      await this._store.set(
        'did',
        await this.encryptPortableDid(storedPortableDid, derivedMaterial.contentEncryptionKey),
      );
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
      if (!isIdentityVaultStatus(backupData.status)) {
        throw new Error('HdIdentityVault: Invalid IdentityVaultStatus object in backup.');
      }
      await this._store.set('did', backupData.did);
      await this._store.set('contentEncryptionKey', backupData.contentEncryptionKey);
      // Status comes entirely from the backup — a legacy `v1` backup must not inherit the local
      // vault's `derivationVersion`.
      const restoredStatus: IdentityVaultStatus = {
        initialized : backupData.status.initialized,
        lastBackup  : backupData.status.lastBackup,
        lastRestore : backupData.status.lastRestore,
      };
      if (backupData.status.derivationVersion !== undefined) {
        restoredStatus.derivationVersion = backupData.status.derivationVersion;
      }
      await this.writeStatus(restoredStatus);

      // Attempt to unlock the vault with the given `password`.
      await this.unlock({ password });

    } catch {
      // If the restore operation fails, revert the data store to the status and contents that were
      // saved before the restore operation was attempted.
      await this.writeStatus(previousStatus);
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
        keyManager : new LocalKeyManager(),
        options    : {
          allowedAlgs : ['PBES2-HS512+A256KW'],
          allowedEncs : ['A256GCM'],
          minP2cCount : 1, // Vault decrypts its own JWEs; no external-input floor needed.
        },
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
      keyManager : new LocalKeyManager(),
      options    : {
        allowedAlgs : ['dir'],
        allowedEncs : ['A256GCM'],
        minP2cCount : 1,
      },
    });

    return plaintext;
  }

  private async deriveVaultMaterial({
    password,
    recoveryPhrase,
    dwnEndpoints,
    derivationVersion,
  }: HdIdentityVaultInitializeParams & { derivationVersion: VaultDerivationVersion }): Promise<HdIdentityVaultDerivedMaterial> {
    this.validatePassword(password);
    const resolvedRecoveryPhrase = this.resolveRecoveryPhrase(recoveryPhrase);
    const paths = VAULT_DERIVATION_PATHS[derivationVersion];

    const rootSeed = await mnemonicToSeed(resolvedRecoveryPhrase);
    const rootHdKey = Ed25519HdKey.fromMasterSeed(rootSeed);

    // The vault key is deterministic so the same phrase can re-derive both the CEK and unlock salt.
    // HKDF inputs are identical across derivation versions; only the path differs.
    const vaultHdKey = rootHdKey.derive(paths.vault);
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
      portableDid: await this.derivePortableDid({ rootHdKey, dwnEndpoints, paths }),
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

  private validateDerivationVersion(derivationVersion?: VaultDerivationVersion): void {
    if (derivationVersion !== undefined && derivationVersion !== 1 && derivationVersion !== 2) {
      throw new Error(
        `HdIdentityVault: Unsupported derivation version '${derivationVersion}'. Supported versions are 1 and 2.`
      );
    }
  }

  private validateRecoveryPhrase(recoveryPhrase: string): void {
    if (isEmptyString(recoveryPhrase)) {
      throw new Error(
        'HdIdentityVault: The recovery phrase is required and cannot be blank. Please provide a ' +
        'valid BIP-39 recovery phrase.'
      );
    }
    if (!validateMnemonic(recoveryPhrase, wordlist)) {
      throw new Error(
        'HdIdentityVault: The provided recovery phrase is invalid. Please ensure that the ' +
        'recovery phrase is a correctly formatted series of 12 words.'
      );
    }
  }

  private resolveRecoveryPhrase(recoveryPhrase?: string): string {
    if (recoveryPhrase !== undefined) {
      this.validateRecoveryPhrase(recoveryPhrase);
      return recoveryPhrase;
    }

    return generateMnemonic(wordlist, 128);
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

  private async derivePortableDid({
    rootHdKey,
    dwnEndpoints,
    paths,
  }: {
    rootHdKey: Ed25519HdKey;
    dwnEndpoints?: string[];
    paths: VaultDerivationPaths;
  }): Promise<PortableDid> {
    const identityHdKey = rootHdKey.derive(paths.identity);
    const identityPrivateKey = await this.crypto.bytesToPrivateKey({
      algorithm       : 'Ed25519',
      privateKeyBytes : identityHdKey.privateKey,
    });

    const signingHdKey = rootHdKey.derive(paths.signing);
    const signingPrivateKey = await this.crypto.bytesToPrivateKey({
      algorithm       : 'Ed25519',
      privateKeyBytes : signingHdKey.privateKey,
    });

    const encryptionHdKey = rootHdKey.derive(paths.encryption);
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

    const did = await DidDht.create({ keyManager: deterministicKeyGenerator, options });
    const portableDid = await did.export();
    if (dwnEndpoints !== undefined) {
      portableDid.document = replaceDwnServiceEndpointUrls(portableDid.document, dwnEndpoints);
    }
    return portableDid;
  }

  /**
   * Resolve recovery material with automatic `v2 → v1` fallback.
   *
   * The DHT is authoritative: `v2` is preferred and `v1` is used only when `v2` is explicitly not
   * found. Resolution errors never fall back, so a gateway or transport failure cannot silently
   * switch a user onto the wrong keys.
   */
  private async recoverVaultMaterial({
    password,
    recoveryPhrase,
    dwnEndpoints,
    derivationVersion,
    deferDwnEndpointBootstrap,
  }: HdIdentityVaultInitializeParams & { recoveryPhrase: string }): Promise<{
    derivedMaterial: HdIdentityVaultDerivedMaterial;
    portableDid: StoredVaultDid;
    resolvedVersion: VaultDerivationVersion;
  }> {
    const reconcile = (material: HdIdentityVaultDerivedMaterial, resolution: DidResolutionResult): Promise<PortableDid> =>
      this.reconcileRecoveredDid({
        portableDid          : material.portableDid,
        replacementEndpoints : dwnEndpoints,
        deferReplacement     : true,
        deferBootstrap       : deferDwnEndpointBootstrap,
        resolution,
      });

    if (derivationVersion !== undefined) {
      const derivedMaterial = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints, derivationVersion });
      const portableDid = await this.reconcileRecoveredDid({
        portableDid          : derivedMaterial.portableDid,
        replacementEndpoints : dwnEndpoints,
        deferReplacement     : true,
        deferBootstrap       : deferDwnEndpointBootstrap,
      });
      return { derivedMaterial, portableDid, resolvedVersion: derivationVersion };
    }

    const v2Material = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints, derivationVersion: 2 });
    const v2Resolution = await this.resolveDid(v2Material.portableDid.uri);
    if (!this.isDidNotFound(v2Resolution)) {
      return { derivedMaterial: v2Material, portableDid: await reconcile(v2Material, v2Resolution), resolvedVersion: 2 };
    }

    const v1Material = await this.deriveVaultMaterial({ password, recoveryPhrase, dwnEndpoints, derivationVersion: 1 });
    const v1Resolution = await this.resolveDid(v1Material.portableDid.uri);
    if (!this.isDidNotFound(v1Resolution)) {
      return { derivedMaterial: v1Material, portableDid: await reconcile(v1Material, v1Resolution), resolvedVersion: 1 };
    }

    return { derivedMaterial: v2Material, portableDid: await reconcile(v2Material, v2Resolution), resolvedVersion: 2 };
  }

  /** Resolve through the agent-supplied resolver, preferring its cache-refreshing variant. */
  private async resolveDid(didUri: string): Promise<DidResolutionResult> {
    return this._didResolver.refreshResolution === undefined
      ? await this._didResolver.resolve(didUri, {})
      : await this._didResolver.refreshResolution(didUri);
  }

  private isDidNotFound(resolution: DidResolutionResult): boolean {
    return resolution.didResolutionMetadata.error === DidErrorCode.NotFound;
  }

  /** Reconcile a recovered DID with its authoritative document before any vault write. */
  private async reconcileRecoveredDid({
    portableDid,
    replacementEndpoints,
    deferReplacement = false,
    deferBootstrap = false,
    useStoredOnNotFound = false,
    resolution,
  }: HdIdentityVaultReconcileRecoveredDidParams): Promise<PortableDid> {
    const didResolution = resolution ?? await this.resolveDid(portableDid.uri);

    if (didResolution.didResolutionMetadata.error === DidErrorCode.NotFound) {
      return this.reconcileNotFoundDid({
        portableDid,
        replacementEndpoints,
        deferReplacement,
        deferBootstrap,
        useStoredOnNotFound,
      });
    }
    if (didResolution.didResolutionMetadata.error !== undefined || didResolution.didDocument === null) {
      throw new Error(
        didResolution.didResolutionMetadata.errorMessage
        ?? `HdIdentityVault: Unable to resolve recovered DID '${portableDid.uri}'.`
      );
    }

    const resolvedDocument = didResolution.didDocument;
    const resolvedEndpoints = getDwnEndpointStatus(portableDid.uri, resolvedDocument);
    if (resolvedEndpoints.status !== 'ready') {
      if (replacementEndpoints === undefined) {
        throw new Error(resolvedEndpoints.message);
      }
      const publicDocument = replaceDwnServiceEndpointUrls(resolvedDocument, replacementEndpoints);
      const localDocument = replaceDwnServiceEndpointUrls(portableDid.document, replacementEndpoints);
      if (deferBootstrap) {
        return { ...portableDid, document: localDocument, metadata: { ...portableDid.metadata, published: false } };
      }
      return this.publishPortableDid(portableDid, publicDocument, localDocument);
    }

    const localDocument = this.copyResolvedDwnService(portableDid.document, resolvedDocument);
    if (replacementEndpoints === undefined || deferReplacement) {
      return {
        ...portableDid,
        document : localDocument,
        metadata : didResolution.didDocumentMetadata,
      };
    }

    const publicDocument = replaceDwnServiceEndpointUrls(resolvedDocument, replacementEndpoints);
    const updatedLocalDocument = replaceDwnServiceEndpointUrls(localDocument, replacementEndpoints);
    return this.publishPortableDid(portableDid, publicDocument, updatedLocalDocument);
  }

  private async reconcileNotFoundDid({
    portableDid,
    replacementEndpoints,
    deferReplacement = false,
    deferBootstrap = false,
    useStoredOnNotFound = false,
  }: HdIdentityVaultReconcileRecoveredDidParams): Promise<PortableDid> {
    const storedEndpoints = useStoredOnNotFound && (replacementEndpoints === undefined || deferReplacement)
      ? getDwnEndpointStatus(portableDid.uri, portableDid.document)
      : undefined;
    if (storedEndpoints?.status === 'ready' && portableDid.metadata.published !== false) {
      return this.publishPortableDid(portableDid);
    }
    if (replacementEndpoints === undefined) {
      if (storedEndpoints?.status === 'ready') {
        throw new Error('HdIdentityVault: Unpublished recovery endpoints require explicit DWN endpoints to complete recovery.');
      }
      throw new Error(storedEndpoints?.message ??
        `HdIdentityVault: Recovered DID '${portableDid.uri}' was not found. Provide DWN endpoints explicitly to bootstrap recovery.`);
    }
    const document = replaceDwnServiceEndpointUrls(portableDid.document, replacementEndpoints);
    return deferBootstrap
      ? { ...portableDid, document, metadata: { ...portableDid.metadata, published: false } }
      : this.publishPortableDid(portableDid, document, document);
  }

  /** Publish using locally controlled keys while allowing the public document to remain authoritative. */
  private async publishPortableDid(
    portableDid: PortableDid,
    publicDocument: DidDocument = portableDid.document,
    localDocument: DidDocument = publicDocument,
  ): Promise<PortableDid> {
    const did = await BearerDid.import({ portableDid });
    did.document = structuredClone(publicDocument);
    const result = await (this._didResolver.publish?.({ did }) ?? DidDht.publish({ did }));
    if (result.didDocumentMetadata.published === false) {
      throw new Error(`HdIdentityVault: Failed to publish vault DID '${portableDid.uri}'.`);
    }
    const resolution = {
      didDocument           : publicDocument,
      didDocumentMetadata   : result.didDocumentMetadata,
      didResolutionMetadata : {},
    };
    await this._didResolver.cacheResolution?.(portableDid.uri, resolution);
    await this._didResolver.pinResolution?.(portableDid.uri, resolution);

    return {
      ...portableDid,
      document : structuredClone(localDocument),
      metadata : result.didDocumentMetadata,
    };
  }

  /** Copy only the resolved #dwn service onto the locally controlled document. */
  private copyResolvedDwnService(target: DidDocument, source: DidDocument): DidDocument {
    const isDwnService = (id: string): boolean =>
      id === `${source.id}#dwn` || id === '#dwn' || id === 'dwn';
    const sourceService = source.service?.find(service => isDwnService(service.id));
    const document = structuredClone(target);
    document.service = document.service?.filter(service => !isDwnService(service.id));
    if (sourceService !== undefined) {
      document.service ??= [];
      document.service.push(structuredClone(sourceService));
    }
    if (document.service?.length === 0) {
      delete document.service;
    }
    return document;
  }

  private async encryptPortableDid(portableDid: PortableDid, contentEncryptionKey: Jwk): Promise<string> {
    return CompactJwe.encrypt({
      key             : contentEncryptionKey,
      plaintext       : Convert.object(portableDid).toUint8Array(),
      protectedHeader : { alg: 'dir', enc: 'A256GCM', cty: 'json' },
      keyManager      : new LocalKeyManager(),
    });
  }

  private async getCachedPortableDid(refresh = false): Promise<StoredVaultDid> {
    if (this.isLocked()) {
      throw new Error('HdIdentityVault: Vault has not been initialized and unlocked.');
    }
    if (refresh || this._cachedPortableDid === undefined) {
      this._cachedPortableDid = await this.decryptStoredPortableDid(this._contentEncryptionKey!);
    }
    return this._cachedPortableDid;
  }

  private async decryptStoredPortableDid(contentEncryptionKey: Jwk): Promise<StoredVaultDid> {
    const { plaintext: portableDidBytes } = await CompactJwe.decrypt({
      jwe        : await this.getStoredDid(),
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
    const pendingSetup: unknown = (portableDid as StoredVaultDid).pendingSetup;
    if (pendingSetup !== undefined && (pendingSetup === null || typeof pendingSetup !== 'object'
      || !('recoveryPhrase' in pendingSetup) || typeof pendingSetup.recoveryPhrase !== 'string'
      || !validateMnemonic(pendingSetup.recoveryPhrase, wordlist)
      || !('registrationRequired' in pendingSetup) || typeof pendingSetup.registrationRequired !== 'boolean')) {
      throw new Error('HdIdentityVault: Unable to decode malformed pending vault setup.');
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
  private async setStatus({ initialized, lastBackup, lastRestore, derivationVersion }: Partial<IdentityVaultStatus>): Promise<boolean> {
    // Get the current status values from the store, if any.
    const vaultStatus = await this.getStatus();

    // Update the status properties with new values specified, if any.
    vaultStatus.initialized = initialized ?? vaultStatus.initialized;
    vaultStatus.lastBackup = lastBackup ?? vaultStatus.lastBackup;
    vaultStatus.lastRestore = lastRestore ?? vaultStatus.lastRestore;
    vaultStatus.derivationVersion = derivationVersion ?? vaultStatus.derivationVersion;

    await this.writeStatus(vaultStatus);

    return true;
  }

  private async writeStatus(vaultStatus: IdentityVaultStatus): Promise<void> {
    // Write the changes to the store.
    await this._store.set('vaultStatus', JSON.stringify(vaultStatus));

    // Update the in-memory cache so subsequent reads skip the store.
    this._cachedInitialized = vaultStatus.initialized;
  }
}
