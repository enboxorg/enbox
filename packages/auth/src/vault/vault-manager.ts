/**
 * VaultManager wraps {@link HdIdentityVault} with a high-level API
 * and emits events on lock/unlock.
 * @module
 */

import type { HdIdentityVault, IdentityVaultBackup } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';

/**
 * Manages the encrypted identity vault lifecycle.
 *
 * The vault stores the agent's DID and content encryption key (CEK),
 * protected by a user password using PBES2-HS512+A256KW with a 210K
 * iteration work factor. The vault supports HD key derivation from
 * a BIP-39 mnemonic for recovery.
 */
export class VaultManager {
  private readonly _vault: HdIdentityVault;
  private readonly _emitter: AuthEventEmitter;

  constructor(vault: HdIdentityVault, emitter: AuthEventEmitter) {
    this._vault = vault;
    this._emitter = emitter;
  }

  /** The underlying vault instance (for advanced usage). */
  get raw(): HdIdentityVault {
    return this._vault;
  }

  /** Whether the vault has been initialized (has encrypted data). */
  async isInitialized(): Promise<boolean> {
    return this._vault.isInitialized();
  }

  /** Whether the vault is currently locked (synchronous check). */
  get isLocked(): boolean {
    return this._vault.isLocked();
  }

  /**
   * Unlock the vault with the given password.
   * Decrypts the CEK into memory so the agent DID can be retrieved.
   *
   * @throws If the password is incorrect or vault is not initialized.
   */
  async unlock(password: string): Promise<void> {
    await this._vault.unlock({ password });
    this._emitter.emit('vault-unlocked', {});
  }

  /**
   * Lock the vault, clearing the CEK from memory.
   * After locking, the password must be provided again to unlock.
   */
  async lock(): Promise<void> {
    await this._vault.lock();
    this._emitter.emit('vault-locked', {});
  }

  /**
   * Change the vault password. Re-encrypts the CEK with the new password.
   *
   * @throws If the old password is incorrect or vault is locked.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this._vault.changePassword({ oldPassword, newPassword });
  }

  /**
   * Create a backup of the vault.
   *
   * @throws If the vault is not initialized or is locked.
   */
  async backup(): Promise<IdentityVaultBackup> {
    return this._vault.backup();
  }

  /**
   * Restore the vault from a backup.
   *
   * @throws If the password doesn't match the backup's encryption.
   */
  async restore(backup: IdentityVaultBackup, password: string): Promise<void> {
    await this._vault.restore({ backup, password });
  }
}
