import type { BearerDid } from '@enbox/dids';
import type { KeyValueStore } from '@enbox/common';

/**
 * Represents the structure of a backup for an IdentityVault, encapsulating all necessary
 * information to restore the vault's state.
 *
 * The encrypted data encompasses all necessary information to reconstruct the vault's state,
 * including the DID, keys, and any other relevant data stored in the vault.
 */
export type IdentityVaultBackup = {
  /** A timestamp to record when the backup was made. */
  dateCreated: string;

  /** The size of the backup data, in bytes. */
  size: number;

  /** Encrypted vault contents. */
  data: string;
};

/**
 * Represents the detailed data structure of a backup for an {@link IdentityVault}.
 *
 * This type is used to encapsulate the essential components needed to fully restore the identity
 * vault from a backup. It is an intermediate representation that holds the DID and the Content
 * Encryption Key (CEK) in Compact JWE format, as well as the current status of the identity vault.
 */
export type IdentityVaultBackupData = {
  /** The encrypted DID associated with the vault in Compact JWE format. */
  did: string;

  /** The encrypted key used to secure the vault's contents in Compact JWE format. */
  contentEncryptionKey: string;

  /** An object detailing the current status of the vault at the time of the backup. */
  status: IdentityVaultStatus;
};

/** Endpoint provenance controls shared by recovery-capable vault operations. */
export type IdentityVaultDwnEndpointRecoveryParams = {
  /** Endpoints used to bootstrap a new or definitively unresolved DID. */
  dwnEndpoints?: string[];

  /** Deliberately replace and publish the endpoints in an existing resolved DID document. */
  replaceDwnEndpoints?: boolean;
};

/** Parameters for initializing a recovery-capable identity vault. */
export type IdentityVaultInitializeParams = IdentityVaultDwnEndpointRecoveryParams & {
  /** The password used to secure the vault. */
  password: string;

  /** An optional recovery phrase used to deterministically recover an existing vault DID. */
  recoveryPhrase?: string;
};

/** Parameters for resetting a vault password by proving the original recovery phrase. */
export type IdentityVaultResetPasswordWithRecoveryPhraseParams = IdentityVaultDwnEndpointRecoveryParams & {
  /** The BIP-39 recovery phrase originally used to initialize the vault. */
  recoveryPhrase: string;

  /** The new password used to unlock the existing vault. */
  password: string;
};

/** Parameters for restoring an encrypted identity vault backup. */
export type IdentityVaultRestoreParams = IdentityVaultDwnEndpointRecoveryParams & {
  /** The encrypted vault backup to restore. */
  backup: IdentityVaultBackup;

  /** The password used to decrypt the backup's content encryption key. */
  password: string;

};

/**
 * Configuration parameters for initializing an {@link IdentityVault} instance. These parameters
 * define the settings and resources used by the {@link IdentityVault} to secure and manage identity
 * data.
 */
export type IdentityVaultParams = {
  /**
   * Optionally defines the computational effort required for key derivation, affecting security and
   * performance.
   */
  keyDerivationWorkFactor?: number;

  /** Optionally specifies a custom key-value store for persisting the vault's encrypted data. */
  store?: KeyValueStore<string, any>;
};

export interface IdentityVault<T extends Record<string, any> = { InitializeResult: any }> {
  /**
   * Creates a backup of the current state of the IdentityVault instance returning an
   * {@link IdentityVaultBackup} object.
   *
   * The IdentityVault must be initialized and unlocked or the backup operation will fail.
   */
  backup(): Promise<IdentityVaultBackup>;

  /**
   * Attempts to change the password of the IdentityVault.
   *
   * The IdentityVault must be initialized and the old password correct or the operation will fail.
   *
   * @throws An error if the IdentityVault has not been initialized or the `oldPassword` is
   *         incorrect.
   */
  changePassword(params: { oldPassword: string, newPassword: string }): Promise<void>;

  /**
   * Returns the DID associated with the {@link IdentityVault} instance.
   */
  getDid(): Promise<BearerDid>

  /**
   * Returns an {@link IdentityVaultStatus} object, which provides information about the current
   * status of the `IdentityVault` instance.
   */
  getStatus(): Promise<IdentityVaultStatus>

  /**
   * Initializes the IdentityVault instance with the given `password`.
   */
  initialize(params: IdentityVaultInitializeParams): Promise<T['InitializeResult']>;

  /**
   * Resets the vault password by proving knowledge of the original recovery phrase.
   *
   * Implementations must leave existing vault contents unchanged when the phrase does not match.
   */
  resetPasswordWithRecoveryPhrase(params: IdentityVaultResetPasswordWithRecoveryPhraseParams): Promise<void>;

  /**
   * Returns a boolean indicating whether the IdentityVault has been initialized.
   */
  isInitialized(): Promise<boolean>;

  /**
   * Returns a boolean indicating whether the IdentityVault is currently locked.
   */
  isLocked(): boolean;

  /**
   * Locks the IdentityVault, secured by a password that must be entered to unlock.
   */
  lock(): Promise<void>;

  /**
   * Restores the IdentityVault instance to the state in the provided {@link IdentityVaultBackup}
   * object. Implementations reconcile the restored DID with resolution before committing it.
   *
   * @throws An error if the backup is invalid, the password is incorrect, DID resolution fails, or
   *         DID publication fails.
   */
  restore(params: IdentityVaultRestoreParams): Promise<void>;

  /**
   * Attempts to unlock the IdentityVault with the provided password.
   *
   * @throws An error if the password is incorrect.
   */
  unlock(params: { password: string }): Promise<void>;

  /**
   * Encrypts arbitrary data using the vault's content encryption key.
   * The vault must be unlocked.
   *
   * @returns A compact JWE string that can be safely stored in untrusted storage.
   * @throws An error if the vault is locked.
   */
  encryptData(params: { plaintext: Uint8Array }): Promise<string>;

  /**
   * Decrypts data that was previously encrypted with {@link encryptData}.
   * The vault must be unlocked.
   *
   * @returns The original plaintext bytes.
   * @throws An error if the vault is locked or the JWE is invalid.
   */
  decryptData(params: { jwe: string }): Promise<Uint8Array>;
}

export type IdentityVaultStatus = {
  /**
   * Boolean indicating whether the IdentityVault has been initialized.
   */
  initialized: boolean;

  /**
   * The timestamp of the last backup.
   */
  lastBackup: string | null;

  /**
   * The timestamp of the last restore.
   */
  lastRestore: string | null;
};
