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

export type IdentityVaultRecoveryOptions = {
  dwnEndpoints?: string[];
  replaceDwnEndpoints?: boolean;
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
  initialize(params: { password: string } & IdentityVaultRecoveryOptions): Promise<T['InitializeResult']>;

  /**
   * Resets the vault password by proving knowledge of the original recovery phrase.
   *
   * Implementations must leave existing vault contents unchanged when the phrase does not match.
   */
  resetPasswordWithRecoveryPhrase(
    params: { recoveryPhrase: string, password: string } & IdentityVaultRecoveryOptions
  ): Promise<void>;

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
   * object.
   *
   * @throws An error if the backup is invalid or the password is incorrect.
   */
  restore(
    params: { backup: IdentityVaultBackup, password: string } & IdentityVaultRecoveryOptions
  ): Promise<void>;

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
