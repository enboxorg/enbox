import type { IdentityVaultBackup } from '../src/types/identity-vault.js';
import type { KeyValueStore } from '@enbox/common';

import sinon from 'sinon';

import { HdIdentityVault } from '../src/hd-identity-vault.js';
import { LevelStore } from '@enbox/common/level-store';
import { MemoryStore } from '@enbox/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidDht, DidErrorCode } from '@enbox/dids';

describe('HdIdentityVault', () => {
  ['MemoryStore', 'LevelStore'].forEach((vaultStoreType) => {
    describe(`with ${vaultStoreType}`, () => {
      let identityVault: HdIdentityVault;
      let vaultStore: KeyValueStore<string, string>;

      beforeAll(() => {
        vaultStore = (vaultStoreType === 'MemoryStore')
          ? new MemoryStore<string, string>()
          : new LevelStore<string, string>({ location: '__TESTDATA__/VAULT_STORE' });
      });

      beforeEach(async () => {
        await vaultStore.clear();
        identityVault = new HdIdentityVault({
          store                   : vaultStore,
          keyDerivationWorkFactor : 1
        });
      });

      afterEach(async () => {
        sinon.restore();
        await vaultStore.clear();
      });

      afterAll(async () => {
        await vaultStore.close();
      });

      describe('backup()', () => {
        it('backs up the vault', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          // The vault should not have been backed up yet.
          let vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.lastBackup).toBeNull();

          // Backup the vault.
          const encryptedBackup = await identityVault.backup();

          // Verify the results.
          expect(encryptedBackup).toBeDefined();
          expect(typeof encryptedBackup.data).toBe('string');
          expect(typeof encryptedBackup.dateCreated).toBe('string');
          expect(encryptedBackup.size).toBeGreaterThan(100);
          vaultStatus = await identityVault.getStatus();
          expect(typeof vaultStatus.lastBackup).toBe('string');
        });

        it('throws an error if the vault is not initialized', async () => {
          try {
            await identityVault.backup();
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('vault has not been initialized');
          }
        });
      });

      describe('changePassword()', () => {
        it('changes the password', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          // Change the password.
          const newPassword = 'brick-shield-anchor';
          await identityVault.changePassword({ oldPassword: 'dumbbell-krakatoa-ditty', newPassword });

          // Verify that the vault is initialized and is unlocked.
          const vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);
        });

        it('throws an error if the vault is not initialized', async () => {
          try {
            await identityVault.changePassword({ oldPassword: 'dumbbell-krakatoa-ditty', newPassword: 'brick-shield-anchor' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('vault has not been initialized');
          }
        });

        it('throws an error if decryption fails due to an incorrect old password', async () => {
          // Initialize the vault with a known password.
          const correctPassword = 'correct-horse-battery-staple';
          await identityVault.initialize({ password: correctPassword });

          // Attempt to change the password using an incorrect old password.
          const incorrectOldPassword = 'incorrect-old-password';
          const newPassword = 'new-super-secure-password';

          try {
            await identityVault.changePassword({
              oldPassword : incorrectOldPassword,
              newPassword : newPassword
            });
            // If no error is thrown, the test should fail.
            throw new Error('Expected an error to be thrown due to incorrect old password.');
          } catch (error: any) {
            expect(error.message).toContain('incorrectly entered old password');

            // Verify that the vault is locked after the failed decryption attempt.
            expect(identityVault.isLocked()).toBe(true);
          }
        });
      });

      describe('resetPasswordWithRecoveryPhrase()', () => {
        const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
        const otherRecoveryPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

        it('resets the password when the recovery phrase matches the initialized vault', async () => {
          await identityVault.initialize({
            password: 'old-password',
            recoveryPhrase,
          });
          const didBefore = (await identityVault.getDid()).uri;

          await identityVault.lock();
          await identityVault.resetPasswordWithRecoveryPhrase({
            recoveryPhrase,
            password: 'new-password',
          });

          expect(identityVault.isLocked()).toBe(false);
          expect((await identityVault.getDid()).uri).toBe(didBefore);

          await identityVault.lock();
          await expect(identityVault.unlock({ password: 'old-password' })).rejects.toThrow('incorrect password');

          await identityVault.unlock({ password: 'new-password' });
          expect((await identityVault.getDid()).uri).toBe(didBefore);
        });

        it('leaves the existing vault unchanged when the recovery phrase does not match', async () => {
          await identityVault.initialize({
            password: 'old-password',
            recoveryPhrase,
          });
          const didBefore = (await identityVault.getDid()).uri;

          await identityVault.lock();
          await expect(
            identityVault.resetPasswordWithRecoveryPhrase({
              recoveryPhrase : otherRecoveryPhrase,
              password       : 'new-password',
            })
          ).rejects.toThrow('Recovery phrase does not match');

          expect(identityVault.isLocked()).toBe(true);
          await identityVault.unlock({ password: 'old-password' });
          expect((await identityVault.getDid()).uri).toBe(didBefore);
        });

        it('throws an error if the vault is not initialized', async () => {
          await expect(
            identityVault.resetPasswordWithRecoveryPhrase({
              recoveryPhrase,
              password: 'new-password',
            })
          ).rejects.toThrow('has not been initialized');
        });
      });

      describe('getStatus()', () => {
        it('returns initialized=false when first instantiated', async () => {
          const vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(false);
        });

        it('returns initialized=true after initialization', async () => {
          // Mock initialization having been completed.
          await vaultStore.set(
            'vaultStatus',
            JSON.stringify({
              initialized : true,
              lastBackup  : null,
              lastRestore : null
            })
          );

          const vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
        });
      });

      describe('getDid()', () => {
        it('returns the DID for an initialized vault', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          const did = await identityVault.getDid();

          expect(did).toBeDefined();
          expect(did).toHaveProperty('uri');
          expect(did).toHaveProperty('document');
          expect(did).toHaveProperty('metadata');
          expect(did).toHaveProperty('keyManager');
        });

        it('deterministically returns a DID given a recovery phrase', async () => {
          // Initialize the vault.
          await identityVault.initialize({
            password       : 'dumbbell-krakatoa-ditty',
            recoveryPhrase : 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
          });

          const did = await identityVault.getDid();

          // Verify that the expected DID URI is returned given the recovery phrase.
          expect(did).toHaveProperty('uri', 'did:dht:qftx7z968xcpfy1a1diu75pg5meap3gdtg6ezagaw849wdh6oubo');
        });

        it('throws an error if the vault is not initialized and unlocked', async () => {
          try {
            await identityVault.getDid();
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('has not been initialized and unlocked');
          }
        });
      });

      describe('initialize()', () => {
        it('initializes and unlocks the vault', async () => {
          // Verify that the vault is not initialized and is locked.
          let vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(false);
          expect(identityVault.isLocked()).toBe(true);

          // Initialize the vault.
          const password = 'dumbbell-krakatoa-ditty';
          await identityVault.initialize({ password });

          // Verify that the vault is initialized and is unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);
        });

        it('generates and returns a 12-word mnenomic if one is not provided', async () => {
          // Initialize the vault.
          const generatedRecoveryPhrase = await identityVault.initialize({
            password: 'dumbbell-krakatoa-ditty'
          });

          // Verify that the vault is initialized and is unlocked.
          expect(typeof generatedRecoveryPhrase).toBe('string');
          expect(generatedRecoveryPhrase.split(' ')).toHaveLength(12);
        });

        it('accepts a recovery phrase', async () => {
          const predefinedRecoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

          // Initialize the vault with a recovery phrase.
          const returnedRecoveryPhrase = await identityVault.initialize({
            password       : 'dumbbell-krakatoa-ditty',
            recoveryPhrase : predefinedRecoveryPhrase
          });

          // Verify that the vault is initialized and is unlocked.
          expect(returnedRecoveryPhrase).toBe(predefinedRecoveryPhrase);
        });

        it('preserves resolved endpoints when recovering from a phrase', async () => {
          const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
          identityVault.didResolver = {
            resolve: async (didUri: string): Promise<any> => ({
              didDocument: {
                id      : didUri,
                service : [{
                  id              : `${didUri}#dwn`,
                  type            : 'DecentralizedWebNode',
                  serviceEndpoint : ['https://resolved.example'],
                }],
              },
              didDocumentMetadata   : {},
              didResolutionMetadata : {},
            }),
          };
          const publish = sinon.stub(DidDht, 'publish');

          await identityVault.initialize({
            password: 'password', recoveryPhrase, dwnEndpoints: ['https://default.example'],
          });

          expect(publish.notCalled).toBe(true);
          expect((await identityVault.getDid()).document.service?.[0].serviceEndpoint)
            .toEqual(['https://resolved.example']);
        });

        it('bootstraps endpoints only when a recovered DID is not found', async () => {
          const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
          identityVault.didResolver = {
            resolve: async (): Promise<any> => ({
              didDocument           : null,
              didDocumentMetadata   : {},
              didResolutionMetadata : { error: DidErrorCode.NotFound },
            }),
          };
          const publish = sinon.stub(DidDht, 'publish').resolves({ didDocumentMetadata: {} } as any);

          await identityVault.initialize({
            password: 'password', recoveryPhrase, dwnEndpoints: ['https://default.example'],
          });

          expect(publish.calledOnce).toBe(true);
          expect(publish.firstCall.args[0].did.document.service?.[0].serviceEndpoint)
            .toEqual(['https://default.example']);
        });

        it('leaves the vault uninitialized when recovery resolution fails', async () => {
          const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
          identityVault.didResolver = {
            resolve: async (): Promise<never> => { throw new Error('resolver offline'); },
          };

          await expect(identityVault.initialize({ password: 'password', recoveryPhrase }))
            .rejects.toThrow('resolver offline');
          expect(await identityVault.isInitialized()).toBe(false);
          expect(await vaultStore.get('did')).toBeUndefined();
        });

        it('throws an error if the vault is already initialized', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          try {
            await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Vault has already been initialized');
          }
        });

        it('throws an error if the password is empty', async () => {
          try {
            await identityVault.initialize({ password: '' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('password is required and cannot be blank');
          }
        });
      });

      describe('isInitialized()', () => {
        it('returns false for a newly instantiated vault', async () => {
          const isInitialized = await identityVault.isInitialized();
          expect(isInitialized).toBe(false);
        });

        it('returns true after the vault has been initialized', async () => {
          await identityVault.initialize({ password: 'secure-password' });
          const isInitialized = await identityVault.isInitialized();
          expect(isInitialized).toBe(true);
        });

        it('returns false after the vault has been cleared', async () => {
          await identityVault.initialize({ password: 'secure-password' });
          await vaultStore.clear();
          // After an external store clear (e.g., factory reset), the app would create a fresh
          // vault instance. Simulate that here — the new instance has no cached state and must
          // read from the (now-empty) store.
          const freshVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1
          });
          const isInitialized = await freshVault.isInitialized();
          expect(isInitialized).toBe(false);
        });
      });

      describe('isLocked()', () => {
        it('returns true if the vault is locked', async () => {
          await identityVault.initialize({ password: 'secure-password' });
          await identityVault.lock();
          const isLocked = identityVault.isLocked();
          expect(isLocked).toBe(true);
        });

        it('returns false if the vault is unlocked', async () => {
          await identityVault.initialize({ password: 'secure-password' });
          const isLocked = identityVault.isLocked();
          expect(isLocked).toBe(false);
        });

        it('returns true for a newly instantiated vault', async () => {
          const isLocked = identityVault.isLocked();
          expect(isLocked).toBe(true);
        });
      });

      describe('restore()', () => {
        it('restores the vault from a backup', async () => {
          const password = 'dumbbell-krakatoa-ditty';

          // Initialize the vault.
          await identityVault.initialize({ password });

          // Backup the vault.
          const encryptedBackup = await identityVault.backup();

          // The vault should not have been restored.
          let vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.lastRestore).toBeNull();

          // Restore the vault from the backup.
          await identityVault.restore({ password, backup: encryptedBackup });

          // Verify the results.
          vaultStatus = await identityVault.getStatus();
          expect(typeof vaultStatus.lastRestore).toBe('string');
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);
        });

        it('replaces only resolved #dwn endpoints when explicitly requested', async () => {
          const publish = sinon.stub(DidDht, 'publish').resolves({ didDocumentMetadata: {} } as any);
          const password = 'password';
          await identityVault.initialize({ password, dwnEndpoints: ['https://old.example'] });
          const backup = await identityVault.backup();
          identityVault.didResolver = {
            resolve: async (didUri: string): Promise<any> => ({
              didDocument: {
                id      : didUri,
                service : [{
                  id              : `${didUri}#other`,
                  type            : 'Other',
                  serviceEndpoint : 'https://other.example',
                }, {
                  id              : `${didUri}#dwn`,
                  type            : 'DecentralizedWebNode',
                  serviceEndpoint : ['https://old.example'],
                }],
              },
              didDocumentMetadata   : {},
              didResolutionMetadata : {},
            }),
          };

          await identityVault.restore({
            backup, password, dwnEndpoints: ['https://new.example'],
          });

          expect(publish.lastCall.args[0].did.document.service).toEqual([{
            id              : `${publish.lastCall.args[0].did.uri}#other`,
            type            : 'Other',
            serviceEndpoint : 'https://other.example',
          }, {
            id              : `${publish.lastCall.args[0].did.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://new.example'],
          }]);
        });

        it('preserves DID resolution errors during restore', async () => {
          const password = 'password';
          await identityVault.initialize({ password });
          const backup = await identityVault.backup();
          identityVault.didResolver = {
            resolve: async (): Promise<never> => { throw new Error('resolver offline'); },
          };

          await expect(identityVault.restore({ backup, password })).rejects.toThrow('resolver offline');
        });

        it('reverts to the previous vault contents if conversion of backup data fails', async () => {
          const backup: IdentityVaultBackup = {
            data        : 'invalid-backup-data',
            dateCreated : new Date().toISOString(),
            size        : 123
          };

          const password = 'dumbbell-krakatoa-ditty';

          // Initialize the vault.
          await identityVault.initialize({ password });

          // Mock the initial vault state
          const previousStatus = await vaultStore.get('vaultStatus');
          const previousContentEncryptionKey = await vaultStore.get('contentEncryptionKey');
          const previousDid = await vaultStore.get('did');

          try {
            await identityVault.restore({ backup, password });
            throw new Error('Expected an error to be thrown due to backup data conversion failure.');
          } catch (error: any) {
            expect(error.message).toContain('invalid backup data or an incorrect password');

            // Verify that the vault contents are unchanged
            const currentStatus = await vaultStore.get('vaultStatus');
            const currentContentEncryptionKey = await vaultStore.get('contentEncryptionKey');
            const currentDid = await vaultStore.get('did');

            expect(currentStatus).toEqual(previousStatus);
            expect(currentContentEncryptionKey).toBe(previousContentEncryptionKey);
            expect(currentDid).toBe(previousDid);
          }
        });

        it('throws an error if the vault is not initialized', async () => {
          try {
            await identityVault.backup();
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('vault has not been initialized');
          }
        });

        it('throws an error if the existing vault contents are missing or inaccessible', async () => {
          const backup: IdentityVaultBackup = {
            data        : 'a.b.c.d.e',
            dateCreated : new Date().toISOString(),
            size        : 123
          };
          const password = 'test-password';

          try {
            vaultStore.delete('vaultStatus');
            await identityVault.restore({ backup, password });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('restore operation cannot proceed');
            expect(error.message).toContain('vault contents are missing or inaccessible');
          }

          try {
            vaultStore.delete('did');
            await identityVault.restore({ backup, password });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('restore operation cannot proceed');
            expect(error.message).toContain('vault contents are missing or inaccessible');
          }

          try {
            vaultStore.delete('contentEncryptionKey');
            await identityVault.restore({ backup, password });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('restore operation cannot proceed');
            expect(error.message).toContain('vault contents are missing or inaccessible');
          }
        });
      });

      describe('unlock()', () => {
        it('unlocks a locked vault', async () => {
          // Validate that the vault is not initialized and is locked.
          let vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(false);
          expect(identityVault.isLocked()).toBe(true);

          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          // Validate that the vault is now initialized and unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);

          // Lock the vault.
          await identityVault.lock();

          // Validate that the vault is now initialized and unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(true);

          // Unock the vault.
          await identityVault.unlock({ password: 'dumbbell-krakatoa-ditty' });

          // Validate that the vault is now initialized and unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);
        });

        it('unlocks an unlocked vault', async () => {
          // Validate that the vault is not initialized and is locked.
          let vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(false);
          expect(identityVault.isLocked()).toBe(true);

          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          // Validate that the vault is now initialized and unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);

          // Unock the vault (which is already unlocked).
          await identityVault.unlock({ password: 'dumbbell-krakatoa-ditty' });

          // Validate that the vault is initialized and unlocked.
          vaultStatus = await identityVault.getStatus();
          expect(vaultStatus.initialized).toBe(true);
          expect(identityVault.isLocked()).toBe(false);
        });

        it('throws an error if the password is incorrect', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          try {
            await identityVault.unlock({ password: 'incorrect-password' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('incorrect password');
          }
        });

        it('throws an error if the vault is not initialized', async () => {
          try {
            await identityVault.unlock({ password: 'dumbbell-krakatoa-ditty' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Vault has not been initialized');
          }
        });

        it('throws an error if the content encryption key data is missing', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          // Remove the content encryption key data.
          await vaultStore.delete('contentEncryptionKey');

          try {
            await identityVault.unlock({ password: 'dumbbell-krakatoa-ditty' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Unable to retrieve the Content Encryption Key');
          }
        });
      });

      describe('encryption key derivation', () => {
        it('should create DID with X25519 encryption key in verification methods', async () => {
          await identityVault.initialize({ password: 'test-password', dwnEndpoints: ['https://dwn.example.com'] });

          const did = await identityVault.getDid();

          // Verify #enc verification method exists with X25519 curve.
          const encKey = did.document.verificationMethod?.find((vm: any) => vm.id.endsWith('#enc'));
          expect(encKey).toBeDefined();
          expect(encKey?.type).toBe('JsonWebKey');
          expect(encKey?.publicKeyJwk).toHaveProperty('kty', 'OKP');
          expect(encKey?.publicKeyJwk).toHaveProperty('crv', 'X25519');
          expect(encKey?.publicKeyJwk).toHaveProperty('x');
          expect(encKey?.publicKeyJwk).not.toHaveProperty('d'); // Should be public only
        });

        it('should include #enc in keyAgreement and exclude from authentication', async () => {
          await identityVault.initialize({ password: 'test-password', dwnEndpoints: ['https://dwn.example.com'] });

          const did = await identityVault.getDid();
          const doc = did.document;

          // Verify keyAgreement includes #enc.
          expect(Array.isArray(doc.keyAgreement)).toBe(true);
          const encReference = doc.keyAgreement?.find((ref: any) =>
            typeof ref === 'string' && ref.endsWith('#enc')
          );
          expect(encReference).toBeDefined();

          // Verify #enc is NOT in authentication or assertionMethod.
          const encId = doc.verificationMethod?.find((vm: any) => vm.id.endsWith('#enc'))?.id;
          expect(doc.authentication ?? []).not.toContain(encId);
          expect(doc.assertionMethod ?? []).not.toContain(encId);
        });

        it('should deterministically derive the #enc key from a recovery phrase', async () => {
          const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

          // Initialize a vault with a known recovery phrase.
          await identityVault.initialize({
            password       : 'first-password',
            dwnEndpoints   : ['https://dwn.example.com'],
            recoveryPhrase : recoveryPhrase,
          });
          const did1 = await identityVault.getDid();
          const encKey1 = did1.document.verificationMethod?.find((vm: any) => vm.id.endsWith('#enc'));

          // Create a completely fresh vault with the same recovery phrase but
          // a different password — the encryption key should be identical.
          await vaultStore.clear();
          identityVault = new HdIdentityVault({ store: vaultStore, keyDerivationWorkFactor: 1 });
          await identityVault.initialize({
            password       : 'different-password',
            dwnEndpoints   : ['https://dwn.example.com'],
            recoveryPhrase : recoveryPhrase,
          });
          const did2 = await identityVault.getDid();
          const encKey2 = did2.document.verificationMethod?.find((vm: any) => vm.id.endsWith('#enc'));

          // Both should produce the same encryption public key.
          expect(encKey1?.publicKeyJwk?.x).toBe(encKey2?.publicKeyJwk?.x);
          expect(encKey1?.publicKeyJwk?.y).toBe(encKey2?.publicKeyJwk?.y);
        });

        it('should use different key indices for identity, signing, and encryption keys', async () => {
          await identityVault.initialize({ password: 'test-password', dwnEndpoints: ['https://dwn.example.com'] });

          const did = await identityVault.getDid();
          const vms = did.document.verificationMethod || [];

          // Verify we have at least 3 keys (identity #0, signing #sig, encryption #enc).
          expect(vms.length).toBeGreaterThanOrEqual(3);

          // Verify each key has different public key material.
          // Use JSON.stringify to handle Ed25519 keys (which have only x, no y).
          const publicKeys = vms.map((vm: any) => JSON.stringify(vm.publicKeyJwk));
          const uniqueKeys = new Set(publicKeys);
          expect(uniqueKeys.size).toBe(vms.length);
        });

        it('should create DWN service without legacy enc/sig properties', async () => {
          await identityVault.initialize({ password: 'test-password', dwnEndpoints: ['https://dwn.example.com'] });

          const did = await identityVault.getDid();

          // Verify DWN service exists but does not include legacy enc/sig properties.
          // Encryption keys are resolved from the DID document's keyAgreement verification methods.
          const dwnService = did.document.service?.find((svc: any) => svc.type === 'DecentralizedWebNode');
          expect(dwnService).toBeDefined();
          expect(dwnService).not.toHaveProperty('enc');
          expect(dwnService).not.toHaveProperty('sig');
          expect(dwnService).toHaveProperty('serviceEndpoint', ['https://dwn.example.com']);
        });
      });
    });
  });
});
