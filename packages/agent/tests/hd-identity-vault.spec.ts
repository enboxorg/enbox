import type { KeyValueStore } from '@enbox/common';
import type { SinonStub } from 'sinon';
import type { DidDocument, DidRegistrationResult, DidResolutionResult, PortableDid } from '@enbox/dids';

import type { IdentityVaultBackup, IdentityVaultBackupData } from '../src/types/identity-vault.js';

import { LevelStore } from '@enbox/common/level-store';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Convert, MemoryStore } from '@enbox/common';
import { DidDht, DidErrorCode, setDwnServiceEndpointUrls } from '@enbox/dids';
import { HdIdentityVault, HdIdentityVaultPartialCommitError } from '../src/hd-identity-vault.js';

import { deferred } from './utils/deferred.js';

type PersistedVaultState = IdentityVaultBackupData & {
  version: 1;
  generation: number;
};

const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function didNotFoundResolution(): DidResolutionResult {
  return {
    didDocument           : null,
    didDocumentMetadata   : {},
    didResolutionMetadata : { error: DidErrorCode.NotFound },
  };
}

function successfulDidResolution(didDocument: DidDocument): DidResolutionResult {
  return {
    didDocument,
    didDocumentMetadata   : { published: true, versionId: 'resolved-version' },
    didResolutionMetadata : {},
  };
}

function stubSuccessfulDidPublish(): SinonStub {
  return sinon.stub(DidDht, 'publish').callsFake(async ({ did }): Promise<DidRegistrationResult> => ({
    didDocument             : structuredClone(did.document),
    didDocumentMetadata     : { ...did.metadata, published: true, versionId: 'published-version' },
    didRegistrationMetadata : {},
  }));
}

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

      async function seedRecoveryVault(dwnEndpoints = ['https://original-dwn.example.com']): Promise<PortableDid> {
        sinon.stub(DidDht, 'resolve').resolves(didNotFoundResolution());
        stubSuccessfulDidPublish();
        await identityVault.initialize({
          password: 'old-password',
          recoveryPhrase,
          dwnEndpoints,
        });
        const portableDid = await (await identityVault.getDid()).export();
        sinon.restore();
        return portableDid;
      }

      async function replaceWithFreshVault(): Promise<void> {
        await vaultStore.clear();
        identityVault = new HdIdentityVault({
          store                   : vaultStore,
          keyDerivationWorkFactor : 1
        });
      }

      async function getPersistedVaultState(): Promise<PersistedVaultState> {
        const serializedState = await vaultStore.get('vaultState');
        if (serializedState === undefined) {
          throw new Error('Expected the atomic vault state to be persisted.');
        }
        return Convert.string(serializedState).toObject() as PersistedVaultState;
      }

      async function prepareRestoreScenario(): Promise<{
        backup: IdentityVaultBackup;
        currentPortableDid: PortableDid;
        restoredPortableDid: PortableDid;
      }> {
        const restoredPortableDid = await seedRecoveryVault();
        const backup = await identityVault.backup();

        await replaceWithFreshVault();
        stubSuccessfulDidPublish();
        await identityVault.initialize({ password: 'current-password' });
        const currentPortableDid = await (await identityVault.getDid()).export();
        sinon.restore();

        return { backup, currentPortableDid, restoredPortableDid };
      }

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

        it('rejects blank replacement passwords without changing or locking the vault', async () => {
          const oldPassword = 'correct-horse-battery-staple';
          await identityVault.initialize({ password: oldPassword });
          const previousState = await getPersistedVaultState();

          for (const newPassword of ['', '   ']) {
            await expect(identityVault.changePassword({ oldPassword, newPassword }))
              .rejects.toThrow('password is required and cannot be blank');
            expect(await getPersistedVaultState()).toEqual(previousState);
            expect(identityVault.isLocked()).toBe(false);
          }

          await identityVault.lock();
          await identityVault.unlock({ password: oldPassword });
          expect(identityVault.isLocked()).toBe(false);
          expect((await getPersistedVaultState()).generation).toBe(previousState.generation);
        });
      });

      describe('resetPasswordWithRecoveryPhrase()', () => {
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
            password     : 'new-password',
            dwnEndpoints : ['https://default-dwn.example.com'],
          });

          expect(identityVault.isLocked()).toBe(false);
          expect((await identityVault.getDid()).uri).toBe(didBefore);

          await identityVault.lock();
          await expect(identityVault.unlock({ password: 'old-password' })).rejects.toThrow('incorrect password');

          await identityVault.unlock({ password: 'new-password' });
          expect((await identityVault.getDid()).uri).toBe(didBefore);
        });

        it('leaves the existing vault unchanged when the recovery phrase does not match', async () => {
          await seedRecoveryVault();
          const didBefore = (await identityVault.getDid()).uri;

          await identityVault.lock();
          const resolveSpy = sinon.spy(DidDht, 'resolve');
          const publishSpy = sinon.spy(DidDht, 'publish');
          await expect(
            identityVault.resetPasswordWithRecoveryPhrase({
              recoveryPhrase : otherRecoveryPhrase,
              password       : 'new-password',
            })
          ).rejects.toThrow('Recovery phrase does not match');

          expect(resolveSpy.called).toBe(false);
          expect(publishSpy.called).toBe(false);
          expect(identityVault.isLocked()).toBe(true);
          await identityVault.unlock({ password: 'old-password' });
          expect((await identityVault.getDid()).uri).toBe(didBefore);
        });

        it('reconciles the resolved DID after validating a matching phrase without publishing', async () => {
          const storedPortableDid = await seedRecoveryVault();
          const resolvedDocument = setDwnServiceEndpointUrls({
            didDocument : storedPortableDid.document,
            endpoints   : ['https://resolved-dwn.example.com'],
          });
          resolvedDocument.service?.push({
            id              : `${storedPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });

          await identityVault.lock();
          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishSpy = sinon.spy(DidDht, 'publish');
          await identityVault.resetPasswordWithRecoveryPhrase({
            recoveryPhrase,
            password     : 'new-password',
            dwnEndpoints : ['https://default-dwn.example.com'],
          });

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          const recoveredDid = await identityVault.getDid();
          expect(recoveredDid.document).toEqual(resolvedDocument);

          await identityVault.lock();
          await expect(identityVault.unlock({ password: 'old-password' })).rejects.toThrow('incorrect password');
          await identityVault.unlock({ password: 'new-password' });
          expect((await identityVault.getDid()).document).toEqual(resolvedDocument);
        });

        it('uses bootstrap endpoints only after a matching phrase resolves to notFound', async () => {
          await seedRecoveryVault();
          await identityVault.lock();

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(didNotFoundResolution());
          const publishStub = stubSuccessfulDidPublish();
          await identityVault.resetPasswordWithRecoveryPhrase({
            recoveryPhrase,
            password     : 'new-password',
            dwnEndpoints : ['https://bootstrap-dwn.example.com'],
          });

          expect(resolveStub.calledBefore(publishStub)).toBe(true);
          expect(publishStub.calledOnce).toBe(true);
          expect(publishStub.firstCall.args[0].did.document.service).toContainEqual({
            id              : `${(await identityVault.getDid()).uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://bootstrap-dwn.example.com'],
          });
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
          stubSuccessfulDidPublish();
          await identityVault.initialize({ password: 'secure-password' });

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
        it('derives the deterministic DID without publishing inside DidDht.create()', async () => {
          const createSpy = sinon.spy(DidDht, 'create');
          const publishStub = stubSuccessfulDidPublish();

          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          expect(createSpy.calledOnce).toBe(true);
          expect(createSpy.firstCall.args[0].options?.publish).toBe(false);
          expect(publishStub.calledOnce).toBe(true);
        });

        it.each([
          { dwnEndpoints: [] },
          { dwnEndpoints: ['ftp://invalid-dwn.example.com'] },
        ])('rejects invalid explicit endpoints before publishing or initializing: $dwnEndpoints', async ({ dwnEndpoints }) => {
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.initialize({
            password: 'dumbbell-krakatoa-ditty',
            dwnEndpoints,
          })).rejects.toThrow();

          expect(publishSpy.notCalled).toBe(true);
          expect(await identityVault.isInitialized()).toBe(false);
        });

        it('publishes bootstrap endpoints only when recovery resolution definitively returns notFound', async () => {
          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(didNotFoundResolution());
          const publishStub = stubSuccessfulDidPublish();

          await identityVault.initialize({
            password     : 'new-password',
            recoveryPhrase,
            dwnEndpoints : ['https://bootstrap-dwn.example.com'],
          });

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishStub.calledOnce).toBe(true);
          expect(resolveStub.calledBefore(publishStub)).toBe(true);
          expect(publishStub.firstCall.args[0].did.document.service?.[0].serviceEndpoint)
            .toEqual(['https://bootstrap-dwn.example.com']);
        });

        it('preserves the resolved document and public-only verification methods without publishing defaults', async () => {
          const storedPortableDid = await seedRecoveryVault();
          await replaceWithFreshVault();

          const resolvedDocument = setDwnServiceEndpointUrls({
            didDocument : storedPortableDid.document,
            endpoints   : ['https://authoritative-dwn.example.com'],
          });
          resolvedDocument.verificationMethod?.push({
            id           : `${storedPortableDid.uri}#external-public`,
            type         : 'JsonWebKey',
            controller   : storedPortableDid.uri,
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });
          resolvedDocument.service?.push({
            id              : `${storedPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishSpy = sinon.spy(DidDht, 'publish');
          await identityVault.initialize({
            password     : 'restored-password',
            recoveryPhrase,
            dwnEndpoints : ['https://default-dwn.example.com'],
          });

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          const recoveredDid = await identityVault.getDid();
          expect(recoveredDid.document).toEqual(resolvedDocument);
          expect(identityVault['_cachedPortableDid']?.privateKeys).toHaveLength(storedPortableDid.privateKeys?.length ?? 0);
          const exportedDid = await recoveredDid.export();
          expect(exportedDid.document).toEqual(resolvedDocument);
          expect(exportedDid.privateKeys).toHaveLength(storedPortableDid.privateKeys?.length ?? 0);
          const identitySigner = await recoveredDid.getSigner({ methodId: '0' });
          const data = new Uint8Array([1, 2, 3]);
          const signature = await identitySigner.sign({ data });
          expect(await identitySigner.verify({ data, signature })).toBe(true);
        });

        it('rejects recovery when the resolved default assertion method is public-only', async () => {
          const storedPortableDid = await seedRecoveryVault();
          await replaceWithFreshVault();
          const externalMethodId = `${storedPortableDid.uri}#external-public`;
          const resolvedDocument = structuredClone(storedPortableDid.document);
          resolvedDocument.verificationMethod?.push({
            id           : externalMethodId,
            type         : 'JsonWebKey',
            controller   : 'did:example:external-controller',
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });
          resolvedDocument.assertionMethod = [
            externalMethodId,
            ...resolvedDocument.assertionMethod ?? [],
          ];
          sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.initialize({
            password: 'restored-password',
            recoveryPhrase,
          })).rejects.toThrow('does not control the assertionMethod key');

          expect(publishSpy.notCalled).toBe(true);
          expect(await identityVault.isInitialized()).toBe(false);
        });

        it('merges and publishes deliberate endpoint replacements after resolution', async () => {
          const storedPortableDid = await seedRecoveryVault();
          await replaceWithFreshVault();

          const resolvedDocument = setDwnServiceEndpointUrls({
            didDocument : storedPortableDid.document,
            endpoints   : ['https://old-dwn.example.com'],
          });
          resolvedDocument.service?.push({
            id              : `${storedPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });
          resolvedDocument.verificationMethod?.push({
            id           : `${storedPortableDid.uri}#external-public`,
            type         : 'JsonWebKey',
            controller   : storedPortableDid.uri,
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishStub = stubSuccessfulDidPublish();
          await identityVault.initialize({
            password            : 'restored-password',
            recoveryPhrase,
            dwnEndpoints        : ['https://replacement-dwn.example.com'],
            replaceDwnEndpoints : true,
          });

          expect(resolveStub.calledBefore(publishStub)).toBe(true);
          expect(publishStub.calledOnce).toBe(true);
          const publishedDocument = publishStub.firstCall.args[0].did.document;
          expect(publishedDocument.service).toContainEqual({
            id              : `${storedPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://replacement-dwn.example.com'],
          });
          expect(publishedDocument.service).toContainEqual({
            id              : `${storedPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });
          expect(publishedDocument.verificationMethod).toContainEqual({
            id           : `${storedPortableDid.uri}#external-public`,
            type         : 'JsonWebKey',
            controller   : storedPortableDid.uri,
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });
        });

        it('rejects a resolved document whose identity key is not controlled by the recovery phrase', async () => {
          const storedPortableDid = await seedRecoveryVault();
          await replaceWithFreshVault();

          const resolvedDocument = structuredClone(storedPortableDid.document);
          const identityVerificationMethod = resolvedDocument.verificationMethod?.find(
            verificationMethod => verificationMethod.id.endsWith('#0')
          );
          if (identityVerificationMethod === undefined) {
            throw new Error('Expected the seeded DID to contain an identity verification method.');
          }
          identityVerificationMethod.publicKeyJwk = {
            alg : 'EdDSA',
            crv : 'Ed25519',
            kty : 'OKP',
            x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
          };

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishSpy = sinon.spy(DidDht, 'publish');
          await expect(identityVault.initialize({
            password: 'restored-password',
            recoveryPhrase,
          })).rejects.toThrow('Recovered vault key material does not control the identity key');

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          expect(await identityVault.isInitialized()).toBe(false);
        });

        it('stops recovery without publishing or initializing on resolver failures', async () => {
          const resolveStub = sinon.stub(DidDht, 'resolve').resolves({
            didDocument           : null,
            didDocumentMetadata   : {},
            didResolutionMetadata : { error: DidErrorCode.InternalError },
          });
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.initialize({
            password     : 'new-password',
            recoveryPhrase,
            dwnEndpoints : ['https://bootstrap-dwn.example.com'],
          })).rejects.toThrow('DID resolution failed: internalError');

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          expect(await identityVault.isInitialized()).toBe(false);
        });

        it('stops recovery without publishing when the resolver throws', async () => {
          const resolveStub = sinon.stub(DidDht, 'resolve').rejects(new Error('gateway unavailable'));
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.initialize({
            password: 'new-password',
            recoveryPhrase,
          })).rejects.toThrow('DID resolution failed');

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          expect(await identityVault.isInitialized()).toBe(false);
        });

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

      describe('atomic persistence', () => {
        it('migrates a complete legacy vault into one authoritative state record', async () => {
          stubSuccessfulDidPublish();
          await identityVault.initialize({ password: 'legacy-password' });
          const originalDidUri = (await identityVault.getDid()).uri;
          const state = await getPersistedVaultState();

          await vaultStore.clear();
          await vaultStore.set('did', state.did);
          await vaultStore.set('contentEncryptionKey', state.contentEncryptionKey);
          await vaultStore.set('vaultStatus', JSON.stringify(state.status));

          const migratedVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1,
          });
          expect((await migratedVault.getStatus()).initialized).toBe(true);
          expect(await getPersistedVaultState()).toEqual(state);
          expect(await vaultStore.get('did')).toBeUndefined();
          expect(await vaultStore.get('contentEncryptionKey')).toBeUndefined();
          expect(await vaultStore.get('vaultStatus')).toBeUndefined();

          await migratedVault.unlock({ password: 'legacy-password' });
          expect((await migratedVault.getDid()).uri).toBe(originalDidUri);
        });

        it('serializes concurrent initialization before the check and publish side effect', async () => {
          const publishStarted = deferred();
          const releasePublish = deferred();
          const publishStub = sinon.stub(DidDht, 'publish').callsFake(async ({ did }): Promise<DidRegistrationResult> => {
            publishStarted.resolve();
            await releasePublish.promise;
            return {
              didDocument             : structuredClone(did.document),
              didDocumentMetadata     : { ...did.metadata, published: true },
              didRegistrationMetadata : {},
            };
          });
          const competingVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1,
          });

          const firstInitialization = identityVault.initialize({ password: 'first-password' });
          await publishStarted.promise;
          const secondInitialization = competingVault.initialize({ password: 'second-password' });
          const secondOutcome = secondInitialization.then(
            (): Error | undefined => undefined,
            (error: Error): Error => error,
          );

          await Promise.resolve();
          expect(publishStub.callCount).toBe(1);

          releasePublish.resolve();
          await firstInitialization;
          expect((await secondOutcome)?.message).toContain('Vault has already been initialized');
          expect(publishStub.callCount).toBe(1);
        });

        it('does not expose partial state when the atomic initialization commit fails', async () => {
          stubSuccessfulDidPublish();
          const originalSet = vaultStore.set.bind(vaultStore);
          sinon.stub(vaultStore, 'set').callsFake(async (key, value): Promise<void> => {
            if (key === 'vaultState') {
              throw new Error('atomic put failed');
            }
            await originalSet(key, value);
          });

          let commitError: unknown;
          try {
            await identityVault.initialize({ password: 'secure-password' });
          } catch (error: unknown) {
            commitError = error;
          }
          expect(commitError).toBeInstanceOf(HdIdentityVaultPartialCommitError);
          expect(commitError).toMatchObject({
            code      : 'HD_IDENTITY_VAULT_PARTIAL_COMMIT',
            operation : 'initialize',
            published : true,
          });
          expect((commitError as Error).cause).toMatchObject({ message: 'atomic put failed' });
          expect(await vaultStore.get('vaultState')).toBeUndefined();
          expect(await vaultStore.get('did')).toBeUndefined();
          expect(await vaultStore.get('contentEncryptionKey')).toBeUndefined();
          expect(await vaultStore.get('vaultStatus')).toBeUndefined();
          expect(identityVault.isLocked()).toBe(true);
        });

        it('fences an unlocked sibling when another instance changes the password', async () => {
          stubSuccessfulDidPublish();
          await identityVault.initialize({ password: 'old-password' });
          const siblingVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1,
          });
          await siblingVault.unlock({ password: 'old-password' });

          await identityVault.changePassword({
            oldPassword : 'old-password',
            newPassword : 'new-password',
          });

          await expect(siblingVault.getDid())
            .rejects.toThrow('Vault contents changed in another context');
          expect(siblingVault.isLocked()).toBe(true);
          await expect(siblingVault.unlock({ password: 'old-password' }))
            .rejects.toThrow('incorrect password');
          await siblingVault.unlock({ password: 'new-password' });
          expect(siblingVault.isLocked()).toBe(false);
        });

        it('serializes a competing backup behind restore and rejects its stale generation', async () => {
          const { backup, restoredPortableDid } = await prepareRestoreScenario();
          const competingVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1,
          });
          await competingVault.unlock({ password: 'current-password' });
          const resolutionStarted = deferred();
          const releaseResolution = deferred();
          sinon.stub(DidDht, 'resolve').callsFake(async (): Promise<DidResolutionResult> => {
            resolutionStarted.resolve();
            await releaseResolution.promise;
            return successfulDidResolution(restoredPortableDid.document);
          });

          const restorePromise = identityVault.restore({
            backup,
            password: 'old-password',
          });
          await resolutionStarted.promise;

          let backupCompleted = false;
          const concurrentBackupOutcome = competingVault.backup().then(
            (concurrentBackup): { backup?: IdentityVaultBackup; error?: Error } => ({ backup: concurrentBackup }),
            (error: Error): { backup?: IdentityVaultBackup; error?: Error } => ({ error }),
          ).finally(() => { backupCompleted = true; });
          await Promise.resolve();
          expect(backupCompleted).toBe(false);

          releaseResolution.resolve();
          await restorePromise;
          const concurrentBackup = await concurrentBackupOutcome;
          expect(concurrentBackup.backup).toBeUndefined();
          expect(concurrentBackup.error?.message).toContain('Vault contents changed in another context');
          expect(competingVault.isLocked()).toBe(true);

          await competingVault.unlock({ password: 'old-password' });
          const freshBackup = await competingVault.backup();
          const backupData = Convert.base64Url(freshBackup.data).toObject() as IdentityVaultBackupData;
          const state = await getPersistedVaultState();
          expect(backupData.did).toBe(state.did);
          expect(backupData.contentEncryptionKey).toBe(state.contentEncryptionKey);
          expect(backupData.status.lastRestore).toBe(state.status.lastRestore);
        });

        it('invalidates an unlocked instance after another instance commits a new generation', async () => {
          const portableDid = await seedRecoveryVault();
          const staleVault = new HdIdentityVault({
            store                   : vaultStore,
            keyDerivationWorkFactor : 1,
          });
          await staleVault.unlock({ password: 'old-password' });
          sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(portableDid.document));

          await identityVault.resetPasswordWithRecoveryPhrase({
            recoveryPhrase,
            password: 'new-password',
          });

          await expect(staleVault.getDid())
            .rejects.toThrow('Vault contents changed in another context');
          expect(staleVault.isLocked()).toBe(true);
          await staleVault.unlock({ password: 'new-password' });
          expect((await staleVault.getDid()).uri).toBe(portableDid.uri);
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

        it('preserves the resolved backup DID instead of applying supplied default endpoints', async () => {
          const { backup, restoredPortableDid } = await prepareRestoreScenario();
          const resolvedDocument = setDwnServiceEndpointUrls({
            didDocument : restoredPortableDid.document,
            endpoints   : ['https://authoritative-dwn.example.com'],
          });
          resolvedDocument.service?.push({
            id              : `${restoredPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });
          resolvedDocument.verificationMethod?.push({
            id           : `${restoredPortableDid.uri}#external-public`,
            type         : 'JsonWebKey',
            controller   : restoredPortableDid.uri,
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishSpy = sinon.spy(DidDht, 'publish');
          await identityVault.restore({
            backup,
            password     : 'old-password',
            dwnEndpoints : ['https://default-dwn.example.com'],
          });

          expect(resolveStub.calledOnceWith(restoredPortableDid.uri)).toBe(true);
          expect(publishSpy.called).toBe(false);
          expect((await identityVault.getDid()).document).toEqual(resolvedDocument);
          expect(identityVault['_cachedPortableDid']?.privateKeys)
            .toHaveLength(restoredPortableDid.privateKeys?.length ?? 0);
          expect(typeof (await identityVault.getStatus()).lastRestore).toBe('string');
        });

        it('publishes a deliberate endpoint replacement after resolving the backup DID', async () => {
          const { backup, restoredPortableDid } = await prepareRestoreScenario();
          const resolvedDocument = setDwnServiceEndpointUrls({
            didDocument : restoredPortableDid.document,
            endpoints   : ['https://authoritative-dwn.example.com'],
          });
          resolvedDocument.service?.push({
            id              : `${restoredPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });

          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(successfulDidResolution(resolvedDocument));
          const publishStub = stubSuccessfulDidPublish();
          await identityVault.restore({
            backup,
            password            : 'old-password',
            dwnEndpoints        : ['https://replacement-dwn.example.com'],
            replaceDwnEndpoints : true,
          });

          expect(resolveStub.calledBefore(publishStub)).toBe(true);
          expect(publishStub.calledOnce).toBe(true);
          const restoredDocument = (await identityVault.getDid()).document;
          expect(restoredDocument.service).toContainEqual({
            id              : `${restoredPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://replacement-dwn.example.com'],
          });
          expect(restoredDocument.service).toContainEqual({
            id              : `${restoredPortableDid.uri}#profile`,
            type            : 'LinkedDomains',
            serviceEndpoint : 'https://profile.example.com',
          });
        });

        it('publishes bootstrap endpoints only when the backup DID definitively does not resolve', async () => {
          const { backup, restoredPortableDid } = await prepareRestoreScenario();
          const resolveStub = sinon.stub(DidDht, 'resolve').resolves(didNotFoundResolution());
          const publishStub = stubSuccessfulDidPublish();

          await identityVault.restore({
            backup,
            password     : 'old-password',
            dwnEndpoints : ['https://bootstrap-dwn.example.com'],
          });

          expect(resolveStub.calledBefore(publishStub)).toBe(true);
          expect(publishStub.calledOnce).toBe(true);
          expect((await identityVault.getDid()).document.service).toContainEqual({
            id              : `${restoredPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://bootstrap-dwn.example.com'],
          });
        });

        it('keeps the current vault fully intact when backup DID resolution fails', async () => {
          const { backup, currentPortableDid } = await prepareRestoreScenario();
          const previousState = await vaultStore.get('vaultState');
          const resolveStub = sinon.stub(DidDht, 'resolve').resolves({
            didDocument           : null,
            didDocumentMetadata   : {},
            didResolutionMetadata : { error: DidErrorCode.InternalError },
          });
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.restore({
            backup,
            password: 'old-password',
          })).rejects.toThrow('DID resolution failed: internalError');

          expect(resolveStub.calledOnce).toBe(true);
          expect(publishSpy.called).toBe(false);
          expect(await vaultStore.get('vaultState')).toBe(previousState);
          expect(identityVault.isLocked()).toBe(false);
          expect((await identityVault.getDid()).uri).toBe(currentPortableDid.uri);
        });

        it('rejects an incorrect backup password before resolving or changing the current vault', async () => {
          const { backup, currentPortableDid } = await prepareRestoreScenario();
          const previousState = await vaultStore.get('vaultState');
          const resolveSpy = sinon.spy(DidDht, 'resolve');
          const publishSpy = sinon.spy(DidDht, 'publish');

          await expect(identityVault.restore({
            backup,
            password: 'incorrect-password',
          })).rejects.toThrow('invalid backup data or an incorrect password');

          expect(resolveSpy.called).toBe(false);
          expect(publishSpy.called).toBe(false);
          expect(await vaultStore.get('vaultState')).toBe(previousState);
          expect(identityVault.isLocked()).toBe(false);
          expect((await identityVault.getDid()).uri).toBe(currentPortableDid.uri);
        });

        it('keeps the current vault fully intact when backup DID publication fails', async () => {
          const { backup, currentPortableDid } = await prepareRestoreScenario();
          const previousState = await vaultStore.get('vaultState');
          sinon.stub(DidDht, 'resolve').resolves(didNotFoundResolution());
          const publishStub = sinon.stub(DidDht, 'publish').rejects(new Error('gateway unavailable'));

          await expect(identityVault.restore({
            backup,
            password: 'old-password',
          })).rejects.toThrow('gateway unavailable');

          expect(publishStub.calledOnce).toBe(true);
          expect(await vaultStore.get('vaultState')).toBe(previousState);
          expect(identityVault.isLocked()).toBe(false);
          expect((await identityVault.getDid()).uri).toBe(currentPortableDid.uri);
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
          const previousState = await vaultStore.get('vaultState');

          try {
            await identityVault.restore({ backup, password });
            throw new Error('Expected an error to be thrown due to backup data conversion failure.');
          } catch (error: any) {
            expect(error.message).toContain('invalid backup data or an incorrect password');

            // Verify that the vault contents are unchanged
            expect(await vaultStore.get('vaultState')).toBe(previousState);
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

          await expect(identityVault.restore({ backup, password }))
            .rejects.toThrow('vault contents are missing or inaccessible');

          await vaultStore.set('vaultState', 'invalid-vault-state');
          await expect(identityVault.restore({ backup, password }))
            .rejects.toThrow('vault contents are missing or inaccessible');
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

        it('throws an error if the atomic vault state is malformed', async () => {
          // Initialize the vault.
          await identityVault.initialize({ password: 'dumbbell-krakatoa-ditty' });

          const state = await getPersistedVaultState();
          await vaultStore.set('vaultState', JSON.stringify({
            ...state,
            contentEncryptionKey: '',
          }));

          try {
            await identityVault.unlock({ password: 'dumbbell-krakatoa-ditty' });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Invalid vault state object');
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
