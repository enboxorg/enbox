import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';
import type { ModuleDefinition, ModuleRuleSet, ModulesConfigureMessage, X25519KeyEncryptionInput } from '../../src/index.js';

import { ModuleAuthorization } from '../../src/core/module-authorization.js';
import { StoreValidationStateReader } from '../../src/core/validation-state-reader.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, DataStream, Dwn, DwnErrorCode, Encoder, Encryption, KeyAgreementAlgorithm, KeyDerivationScheme, Message, Modules } from '../../src/index.js';
import { createAudienceControlWrite, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

const moduleUri = 'https://example.com/modules/history-revalidation';
const providerUri = 'https://example.com/modules/history-provider';

function timestamp(day: number): string {
  return `2025-08-${day.toString().padStart(2, '0')}T00:00:00.000000Z`;
}

/** Exercises historical admission repair with real signatures and injectable stores. */
export function testModuleHistoryRevalidation(): void {
  describe('Module stored-initial history revalidation', () => {
    let dwn: Dwn;
    let alice: Persona;
    let bob: Persona;

    beforeAll(async () => {
      dwn = await Dwn.create({
        ...TestStores.get(),
        eventLog    : TestEventLog.get(),
        didResolver : new UniversalResolver({ didResolvers: [DidKey] }),
      });
    });

    async function clearStores(): Promise<void> {
      const stores = TestStores.get();
      await stores.messageStore.clear();
      await stores.dataStore.clear();
      await stores.resumableTaskStore.clear();
    }

    beforeEach(async () => {
      await clearStores();
      alice = await TestDataGenerator.generateDidKeyPersona();
      bob = await TestDataGenerator.generateDidKeyPersona();
    });

    afterAll(async () => {
      await dwn.close();
    });

    async function config(definition: ModuleDefinition, day: number): Promise<ModulesConfigureMessage> {
      return (await TestDataGenerator.generateModulesConfigure({
        author: alice, moduleDefinition: definition, messageTimestamp: timestamp(day),
      })).message;
    }

    async function install(message: ModulesConfigureMessage): Promise<void> {
      const reply = await dwn.processMessage(alice.did, message);
      expect(reply.status.code, reply.status.detail).toBe(202);
    }

    async function write(record: GenerateRecordsWriteOutput): Promise<void> {
      const reply = await dwn.processMessage(alice.did, record.message, { dataStream: DataStream.fromBytes(record.dataBytes!) });
      expect(reply.status.code, reply.status.detail).toBe(202);
    }

    async function assertRetained(record: GenerateRecordsWriteOutput, retained: boolean): Promise<void> {
      const { messages } = await TestStores.get().messageStore.query(alice.did, [{ recordId: record.message.recordId }]);
      expect(messages).toHaveLength(retained ? 1 : 0);
      if (retained) {
        expect(await Message.getCid(messages[0])).toBe(await Message.getCid(record.message));
      }
    }

    function reader(): StoreValidationStateReader {
      return new StoreValidationStateReader(TestStores.get());
    }

    for (const invalidRole of ['missing path', 'not a role', 'missing alias']) {
      it(`purges a stored write whose invoked role has ${invalidRole} in newly learned governing history`, async () => {
        const foreign = invalidRole === 'missing alias';
        const provider: ModuleDefinition = {
          module: providerUri, published: true, types: { writer: {} }, structure: { writer: { $role: true } },
        };
        const providerConfig = await config(provider, 1);
        const original: ModuleDefinition = {
          module    : moduleUri,
          published : true,
          ...(foreign ? { uses: { people: providerUri } } : {}),
          types     : { writer: {}, editor: {}, post: {} },
          structure : {
            writer : { $role: true },
            editor : { $role: true },
            post   : { $actions: [{ role: foreign ? 'people:writer' : 'writer', can: ['create'] }] },
          },
        };
        const historical = structuredClone(original);
        historical.structure.post = { $actions: [{ role: foreign ? 'renamed:writer' : 'editor', can: ['create'] }] };
        if (foreign) {
          historical.uses = { renamed: providerUri };
        } else if (invalidRole === 'missing path') {
          delete historical.structure.writer;
        } else {
          historical.structure.writer = {};
        }
        const [first, middle, latest] = await Promise.all([config(original, 2), config(historical, 4), config(original, 8)]);
        await install(providerConfig);
        await install(first);
        await install(latest);
        const role = await TestDataGenerator.generateRecordsWrite({
          author           : alice, recipient        : bob.did, module           : foreign ? providerUri : moduleUri, modulePath       : 'writer',
          dateCreated      : timestamp(3), messageTimestamp : timestamp(3),
        });
        await write(role);
        const post = await TestDataGenerator.generateRecordsWrite({
          author           : bob, module           : moduleUri, modulePath       : 'post', moduleRole       : foreign ? 'people:writer' : 'writer',
          dateCreated      : timestamp(6), messageTimestamp : timestamp(6),
        });
        await write(post);
        await install(middle);
        await assertRetained(post, false);
        await assertRetained(role, true);

        // Learning the same complete signed history before the write rejects it at admission.
        await clearStores();
        for (const message of [providerConfig, first, latest, middle]) {
          await install(message);
        }
        await write(role);
        const rejected = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(post.dataBytes!) });
        expect(rejected.status.code).toBe(401);
        expect(rejected.status.detail).toContain(DwnErrorCode.ModuleAuthorizationNotARole);
      });
    }

    it('purges an apparent local record when newly learned governing history makes its path a reference', async () => {
      const provider: ModuleDefinition = {
        module: providerUri, published: true, types: { root: {} }, structure: { root: {} },
      };
      const original: ModuleDefinition = {
        module: moduleUri, published: true, types: { note: {} }, structure: { note: {} },
      };
      const historical: ModuleDefinition = {
        module    : moduleUri, published : true, uses      : { base: providerUri }, types     : { comment: {} },
        structure : { note: { $ref: 'base:root', comment: {} } },
      };
      await install(await config(provider, 1));
      await install(await config(original, 2));
      await install(await config(original, 8));
      const note = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: moduleUri, modulePath: 'note', dateCreated: timestamp(6), messageTimestamp: timestamp(6),
      });
      await write(note);
      await install(await config(historical, 4));
      await assertRetained(note, false);
      const rejected = await dwn.processMessage(alice.did, note.message, { dataStream: DataStream.fromBytes(note.dataBytes!) });
      expect(rejected.status.code).toBe(400);
      expect(rejected.status.detail).toContain(DwnErrorCode.ModuleAuthorizationRefNodeWriteNotAllowed);
    });

    async function encryptedDefinition(readRole: boolean, keyOwner = alice): Promise<ModuleDefinition> {
      const definition: ModuleDefinition = {
        module    : moduleUri,
        published : true,
        types     : { reader: {}, post: { encryptionRequired: true, dataFormats: ['text/plain'] } },
        structure : { reader: { $role: true }, post: readRole ? { $actions: [{ role: 'reader', can: ['read'] }] } : {} },
      };
      return Modules.deriveAndInjectPublicEncryptionKeys(
        definition, TestDataGenerator.createModulePathKeyDeriver(keyOwner.keyId, keyOwner.encryptionKeyPair.privateJwk)
      );
    }

    async function encryptedPost(
      definition: ModuleDefinition, extraKeyInputs: X25519KeyEncryptionInput[] = [],
    ): Promise<GenerateRecordsWriteOutput> {
      const key = TestDataGenerator.randomBytes(32);
      const initializationVector = TestDataGenerator.randomBytes(16);
      const data = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, initializationVector, Encoder.stringToBytes('secret'));
      const publicKey = (definition.structure.post as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
      return TestDataGenerator.generateRecordsWrite({
        author           : alice, data, dataFormat       : 'text/plain', module           : moduleUri, modulePath       : 'post',
        dateCreated      : timestamp(6), messageTimestamp : timestamp(6),
        encryptionInput  : {
          key, initializationVector,
          keyEncryptionInputs: [{
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw, derivationScheme : KeyDerivationScheme.ModulePath,
            keyId            : await Encryption.getKeyId(publicKey), publicKey,
          }, ...extraKeyInputs],
        },
      });
    }

    for (const missingEnvelope of ['modulePath', 'roleAudience']) {
      it(`purges a stored encrypted write missing the governing ${missingEnvelope} envelope`, async () => {
        const original = await encryptedDefinition(false);
        const historical = missingEnvelope === 'modulePath' ? await encryptedDefinition(false, bob) : await encryptedDefinition(true);
        await install(await config(original, 2));
        await install(await config(original, 8));
        const post = await encryptedPost(original);
        await write(post);
        await install(await config(historical, 4));
        await assertRetained(post, false);
        const rejected = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(post.dataBytes!) });
        expect(rejected.status.code).toBe(400);
        expect(rejected.status.detail).toContain(missingEnvelope === 'modulePath'
          ? DwnErrorCode.ModuleAuthorizationEncryptionModulePathEntryMissing
          : DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceEntryMissing);
      });
    }

    it('retains a stored encrypted write when its valid audience envelope references missing live support', async () => {
      const definition = await encryptedDefinition(true);
      await install(await config(definition, 2));
      await install(await config(definition, 8));
      const audience = await createAudienceControlWrite({
        author           : alice, module           : moduleUri, rolePath         : 'reader', roleRuleSet      : definition.structure.reader as ModuleRuleSet,
        dateCreated      : timestamp(3), messageTimestamp : timestamp(3),
      });
      await processControlWrite(dwn, alice.did, audience);
      const post = await encryptedPost(definition, [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw, derivationScheme : 'roleAudience', module           : moduleUri,
        rolePath         : 'reader', keyId            : audience.keyId, publicKey        : alice.encryptionKeyPair.publicJwk,
      }]);
      await write(post);
      await TestStores.get().messageStore.delete(alice.did, await Message.getCid(audience.recordsWrite.message));
      await expect(ModuleAuthorization.validateStoredInitialWrite(alice.did, post.recordsWrite, reader()))
        .rejects.toThrow(DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceMissing);
      await install(await config(definition, 4));
      await assertRetained(post, true);
    });

    it('retains a stored write when the provider for its governing historical configuration is unavailable', async () => {
      const provider: ModuleDefinition = {
        module: providerUri, published: true, types: { writer: {} }, structure: { writer: { $role: true } },
      };
      const original: ModuleDefinition = {
        module    : moduleUri, published : true, uses      : { people: providerUri }, types     : { post: {} },
        structure : { post: { $actions: [{ role: 'people:writer', can: ['create'] }] } },
      };
      const independent: ModuleDefinition = {
        module: moduleUri, published: true, types: { post: {} }, structure: { post: {} },
      };
      const providerConfig = await config(provider, 1);
      await install(providerConfig);
      await install(await config(original, 4));
      const role = await TestDataGenerator.generateRecordsWrite({
        author           : alice, recipient        : bob.did, module           : providerUri, modulePath       : 'writer',
        dateCreated      : timestamp(5), messageTimestamp : timestamp(5),
      });
      await write(role);
      const post = await TestDataGenerator.generateRecordsWrite({
        author           : bob, module           : moduleUri, modulePath       : 'post', moduleRole       : 'people:writer',
        dateCreated      : timestamp(6), messageTimestamp : timestamp(6),
      });
      await write(post);
      await install(await config(independent, 8));

      // A sparse replica can retain admitted records while their historical provider is absent.
      await TestStores.get().messageStore.delete(alice.did, await Message.getCid(providerConfig));
      await expect(ModuleAuthorization.validateStoredInitialWrite(alice.did, post.recordsWrite, reader()))
        .rejects.toThrow(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled);
      // This older independent configuration admits without the absent provider and triggers repair.
      await install(await config(independent, 2));
      await assertRetained(post, true);
    });
  });
}
