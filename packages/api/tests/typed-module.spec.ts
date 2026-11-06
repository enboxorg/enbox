import type { BearerDid } from '@enbox/dids';
import type { ContextMembersApi } from '../src/typed-enbox.js';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { RecordDeleteParams } from '../src/record-types.js';
import type {
  EncodedRecordData,
  RecordCodec,
  RecordValidationFailure,
  RecordValidator,
} from '../src/record-codec.js';

import sinon from 'sinon';

import { ContextNotReadyError } from '../src/context-errors.js';
import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Module } from '../src/module.js';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { Record } from '../src/record.js';
import { recordCodecs } from '../src/record-codec.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CONTEXT_FOLLOW_PATH,
  CONTEXT_INVITATION_PATH,
  contextFollowCodec,
  contextInvitationCodec,
  isContextFollowIntent,
} from '../src/shared-context-module.js';
import { DateSort, DwnErrorCode } from '@enbox/dwn-sdk-js';
import { defineModule, isTypedModule } from '../src/define-module.js';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

// ---------------------------------------------------------------------------
// Test module definition
// ---------------------------------------------------------------------------

const TodoModuleDefinition = {
  module    : 'https://example.com/modules/todo',
  published : true,
  types     : {
    list: {
      schema      : 'https://example.com/schemas/list',
      dataFormats : ['application/json'],
    },
    task: {
      schema      : 'https://example.com/schemas/task',
      dataFormats : ['application/json'],
    },
    attachment: {
      dataFormats: ['application/octet-stream', 'image/png', 'image/jpeg'],
    },
  },
  structure: {
    list: {
      $actions: [
        { who: 'anyone', can: ['create', 'read'] },
      ],
      task: {
        $actions: [
          { who: 'anyone', can: ['create', 'read'] },
        ],
        attachment: {
          $actions: [
            { who: 'anyone', can: ['create', 'read'] },
          ],
        },
      },
    },
  },
} as const satisfies ModuleDefinition;

const TodoModule = defineModule(TodoModuleDefinition, {
  attachment : recordCodecs.blob(),
  list       : recordCodecs.json<{ name: string; description?: string }>(),
  task       : recordCodecs.json<{ title: string; completed: boolean }>(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('TypedModule API', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/typed-module',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('defineModule()', () => {
    const SharedDefinition = {
      module    : 'https://example.com/modules/shared-contexts',
      published : true,
      types     : {
        blind     : { dataFormats: ['application/json'] },
        member    : { dataFormats: ['application/json'] },
        note      : { dataFormats: ['application/json'], encryptionRequired: true },
        outsider  : { dataFormats: ['application/json'] },
        project   : { dataFormats: ['application/json'] },
        viewer    : { dataFormats: ['application/json'] },
        workspace : { dataFormats: ['application/json'] },
      },
      structure: {
        project: {
          $actions : [{ role: 'project/outsider', can: ['read'] }],
          outsider : { $role: true },
        },
        workspace: {
          $actions: [
            { role: 'workspace/member', can: ['read'] },
            { role: 'workspace/viewer', can: ['read'] },
          ],
          blind  : { $role: true },
          member : { $role: true },
          note   : {},
          viewer : { $role: true },
        },
      },
    } as const satisfies ModuleDefinition;
    const SharedCodecs = {
      blind     : recordCodecs.json<unknown>(),
      member    : recordCodecs.json<unknown>(),
      note      : recordCodecs.json<unknown>(),
      outsider  : recordCodecs.json<unknown>(),
      project   : recordCodecs.json<unknown>(),
      viewer    : recordCodecs.json<unknown>(),
      workspace : recordCodecs.json<unknown>(),
    };
    const defineSharedModule = (): {
      codecs: globalThis.Record<string, RecordCodec<unknown>>;
      definition: ModuleDefinition;
    } => defineModule(SharedDefinition, SharedCodecs);

    it('should return a TypedModule with the original definition', () => {
      expect(TodoModule.definition).toBe(TodoModuleDefinition);
      expect(TodoModule.definition.module).toBe('https://example.com/modules/todo');
    });

    it('should preserve the types and structure', () => {
      expect(TodoModule.definition.types.list.schema).toBe('https://example.com/schemas/list');
      expect(TodoModule.definition.structure.list).toBeDefined();
    });

    it('should reject missing, unexpected, and invalid runtime codecs', () => {
      const missing = { ...TodoModule.codecs } as Partial<typeof TodoModule.codecs>;
      delete missing.attachment;
      expect(() => defineModule(TodoModuleDefinition, missing as typeof TodoModule.codecs))
        .toThrow('missing: attachment');

      const unexpected = { ...TodoModule.codecs, orphan: recordCodecs.json<unknown>() };
      expect(() => defineModule(
        TodoModuleDefinition,
        unexpected as unknown as typeof TodoModule.codecs,
      )).toThrow('unexpected: orphan');

      const invalid = { ...TodoModule.codecs, task: {} };
      expect(() => defineModule(
        TodoModuleDefinition,
        invalid as unknown as typeof TodoModule.codecs,
      )).toThrow('invalid: task');
    });

    it('adds isolated shared-context paths without mutating authored inputs', () => {
      const module = defineSharedModule();

      expect(module.definition).not.toBe(SharedDefinition);
      expect(SharedDefinition.types).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(SharedDefinition.structure).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(SharedCodecs).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(module.definition.types[CONTEXT_INVITATION_PATH]).toMatchObject({
        dataFormats : ['application/json'],
        schema      : 'https://enbox.id/schemas/context-invitation',
      });
      expect(module.definition.structure[CONTEXT_INVITATION_PATH]).toEqual({
        $actions   : [{ who: 'anyone', can: ['create'] }],
        $immutable : true,
        $size      : { max: 8_192 },
      });
      expect(module.codecs[CONTEXT_INVITATION_PATH]).toBe(contextInvitationCodec);
      expect(SharedDefinition.types).not.toHaveProperty(CONTEXT_FOLLOW_PATH);
      expect(SharedDefinition.structure).not.toHaveProperty(CONTEXT_FOLLOW_PATH);
      expect(SharedCodecs).not.toHaveProperty(CONTEXT_FOLLOW_PATH);
      expect(module.definition.types[CONTEXT_FOLLOW_PATH]).toEqual({
        dataFormats        : ['application/json'],
        encryptionRequired : true,
        schema             : 'https://enbox.id/schemas/context-follow',
      });
      expect(module.definition.structure[CONTEXT_FOLLOW_PATH]).toEqual({
        $immutable : true,
        $size      : { max: 8_192 },
      });
      expect(module.codecs[CONTEXT_FOLLOW_PATH]).toBe(contextFollowCodec);
      expect(isTypedModule(module)).toBe(true);

      const other = defineSharedModule();
      expect(other.definition.types[CONTEXT_INVITATION_PATH])
        .not.toBe(module.definition.types[CONTEXT_INVITATION_PATH]);
      expect(other.definition.structure[CONTEXT_INVITATION_PATH])
        .not.toBe(module.definition.structure[CONTEXT_INVITATION_PATH]);
      expect(other.definition.types[CONTEXT_FOLLOW_PATH])
        .not.toBe(module.definition.types[CONTEXT_FOLLOW_PATH]);
      expect(other.definition.structure[CONTEXT_FOLLOW_PATH])
        .not.toBe(module.definition.structure[CONTEXT_FOLLOW_PATH]);
    });

    it('derives shared-context support from the authored definition', () => {
      const module = defineModule(SharedDefinition, SharedCodecs);

      expect(isTypedModule(module)).toBe(true);
      expect(new TypedEnbox(dwnAlice, module).contexts).toHaveProperty('invitations');
      expect(isTypedModule({ definition: SharedDefinition, codecs: SharedCodecs })).toBe(false);
    });

    it('rejects altered or incomplete private following definitions', () => {
      const module = defineSharedModule();
      const definition = module.definition;
      const type = definition.types[CONTEXT_FOLLOW_PATH];
      const rule = definition.structure[CONTEXT_FOLLOW_PATH];
      const altered = [
        { ...definition, types: { ...definition.types, [CONTEXT_FOLLOW_PATH]: { ...type, encryptionRequired: false } } },
        { ...definition, structure: { ...definition.structure, [CONTEXT_FOLLOW_PATH]: {
          ...rule, $actions: [{ who: 'anyone' as const, can: ['read' as const] }],
        } } },
        { ...definition, structure: { ...definition.structure, [CONTEXT_FOLLOW_PATH]: { ...rule, $immutable: false } } },
      ];
      for (const candidate of altered) {
        expect(isTypedModule({ ...module, definition: candidate })).toBe(false);
      }
      expect(isTypedModule({
        ...module,
        codecs: { ...module.codecs, [CONTEXT_FOLLOW_PATH]: recordCodecs.json<unknown>() },
      })).toBe(false);
      const missing = { ...module.codecs };
      delete missing[CONTEXT_FOLLOW_PATH];
      expect(isTypedModule({ ...module, codecs: missing })).toBe(false);
    });

    it('validates following and forgotten intents without trusting invalid owner coordinates', () => {
      const intent = { ownerDid: 'did:example:owner', contextId: 'workspaceRecord', path: 'workspace', following: true };
      const forgotten = { ownerDid: intent.ownerDid, contextId: intent.contextId, following: false };
      expect(isContextFollowIntent(intent)).toBe(true);
      expect(isContextFollowIntent(forgotten)).toBe(true);
      expect(isContextFollowIntent({ ...forgotten, path: 'unavailable' })).toBe(true);
      for (const invalid of [
        null, [], { ...intent, ownerDid: 'https://owner.example' },
        { ...intent, contextId: '' }, { ...intent, path: '' }, { ...intent, path: undefined }, { ...intent, following: 'true' },
        { ...forgotten, ownerDid: 'https://owner.example' }, { ...forgotten, contextId: '' },
      ]) {
        expect(isContextFollowIntent(invalid)).toBe(false);
        expect(() => contextFollowCodec.encode(invalid as typeof intent)).toThrow();
      }
    });

    it('encrypts following intents and keeps them private and immutable in the recipient tenant', async () => {
      const module = defineSharedModule();
      const typed = new TypedEnbox(dwnAlice, module);
      const intent = { ownerDid: 'did:example:owner', contextId: 'workspaceRecord', path: 'workspace', following: true };
      const record = await typed.records.create(CONTEXT_FOLLOW_PATH, { data: intent });

      expect(record.encryption).toBeDefined();
      expect(await record.value()).toEqual(intent);
      await expect(record.update({ data: { ownerDid: intent.ownerDid, contextId: intent.contextId, following: false } }))
        .rejects.toThrow(DwnErrorCode.ModuleAuthorizationImmutableRecord);

      const stranger = await testHarness.agent.did.create({ method: 'jwk', store: true });
      const { reply } = await testHarness.agent.processDwnRequest({
        author        : stranger.uri,
        target        : aliceDid.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { module: module.definition.module, modulePath: CONTEXT_FOLLOW_PATH } },
      });
      expect(reply.status.code).toBe(200);
      expect(reply.entries).toEqual([]);
    });

    it('rejects managed invitation fragments with altered semantics', () => {
      const module = defineSharedModule();
      const type = module.definition.types[CONTEXT_INVITATION_PATH];
      const rule = module.definition.structure[CONTEXT_INVITATION_PATH];

      expect(isTypedModule({
        ...module,
        definition: {
          ...module.definition,
          types: { ...module.definition.types, [CONTEXT_INVITATION_PATH]: { ...type, encryptionRequired: true } },
        },
      })).toBe(false);
      expect(isTypedModule({
        ...module,
        definition: {
          ...module.definition,
          structure: { ...module.definition.structure, [CONTEXT_INVITATION_PATH]: { ...rule, $role: true } },
        },
      })).toBe(false);
    });

    it('reserves the invitation type name at the module boundary', () => {
      for (const property of ['types', 'structure'] as const) {
        const definition = {
          ...TodoModuleDefinition,
          [property]: {
            ...TodoModuleDefinition[property],
            [CONTEXT_INVITATION_PATH]: {},
          },
        } as unknown as typeof TodoModuleDefinition;
        expect(() => defineModule(definition, TodoModule.codecs)).toThrow(
          `'${CONTEXT_INVITATION_PATH}' is reserved for shared-context invitations`,
        );
      }
    });

    it('reserves the following type name at the module boundary', () => {
      for (const property of ['types', 'structure'] as const) {
        const definition = {
          ...TodoModuleDefinition,
          [property]: {
            ...TodoModuleDefinition[property],
            [CONTEXT_FOLLOW_PATH]: {},
          },
        } as unknown as typeof TodoModuleDefinition;
        expect(() => defineModule(definition, TodoModule.codecs)).toThrow(
          `'${CONTEXT_FOLLOW_PATH}' is reserved for shared-context following`,
        );
      }
    });
  });

  describe('TypedEnbox', () => {
    it('should be constructable from a DwnApi and TypedModule', () => {
      const typed = new TypedEnbox(dwnAlice, TodoModule);
      expect(typed).toBeInstanceOf(TypedEnbox);
    });

    it('should expose the module URI', () => {
      const typed = new TypedEnbox(dwnAlice, TodoModule);
      expect(typed.module).toBe('https://example.com/modules/todo');
    });

    it('should expose the module definition', () => {
      const typed = new TypedEnbox(dwnAlice, TodoModule);
      expect(typed.definition).toBe(TodoModuleDefinition);
    });

    it('should return the same records object on repeated access', () => {
      const typed = new TypedEnbox(dwnAlice, TodoModule);
      const records1 = typed.records;
      const records2 = typed.records;
      expect(records1).toBe(records2);
    });

    it('should import the wallet-owned module configuration when configuring as a delegate', async () => {
      const modulesConfigureMessage = {
        descriptor: {
          interface  : 'Modules',
          method     : 'Configure',
          definition : TodoModuleDefinition,
        },
      };
      const remoteModule = {
        definition : TodoModuleDefinition,
        toJSON     : (): typeof modulesConfigureMessage => modulesConfigureMessage,
      };
      const query = sinon.stub();
      query.resolves({ status: { code: 200, detail: 'OK' }, modules: [remoteModule] });
      const importModuleConfiguration = sinon.stub().resolves({
        status : { code: 202, detail: 'Accepted' },
        module : remoteModule,
      });

      const delegateDwn = {
        connectedDid : aliceDid.uri,
        isDelegate   : true,
        modules      : { query },
        importModuleConfiguration,
      } as unknown as DwnApi;

      const typed = new TypedEnbox(delegateDwn, TodoModule);
      const result = await typed.configure();

      expect(result.status.code).toBe(202);
      expect(importModuleConfiguration.calledOnceWith(modulesConfigureMessage)).toBe(true);
      expect(query.firstCall.args[0]).toEqual({
        from   : aliceDid.uri,
        filter : { module: TodoModuleDefinition.module },
      });
      expect(query.secondCall.args[0]).toEqual({ filter: { module: TodoModuleDefinition.module } });
    });

    it('should import a signed wallet module configuration through Module.toJSON()', async () => {
      const definition = {
        ...TodoModuleDefinition,
        module: `https://example.com/modules/delegate-import/${crypto.randomUUID()}`,
      };
      const { message } = await testHarness.agent.processDwnRequest({
        author        : aliceDid.uri,
        messageParams : { definition },
        messageType   : DwnInterface.ModulesConfigure,
        store         : false,
        target        : aliceDid.uri,
      });
      const remoteModule = new Module(message!);
      const delegateDid = await testHarness.agent.did.create({ store: true, method: 'jwk' });
      const delegateDwn = new DwnApi({
        agent        : testHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : delegateDid.uri,
      });

      const result = await delegateDwn.importModuleConfiguration(remoteModule.toJSON());
      const duplicateResult = await delegateDwn.importModuleConfiguration(remoteModule.toJSON());
      const { modules } = await dwnAlice.modules.query({
        filter: { module: definition.module },
      });

      expect(result.status.code).toBe(202);
      expect(duplicateResult.status.code).toBe(409);
      expect(duplicateResult.module?.definition.module).toBe(definition.module);
      expect(modules).toHaveLength(1);
      expect(modules[0].definition.module).toBe(definition.module);
    });

    it('should reject delegate-signed module configurations imported into the owner tenant', async () => {
      const definition = {
        ...TodoModuleDefinition,
        module: `https://example.com/modules/delegate-import/${crypto.randomUUID()}`,
      };
      const delegateDid = await testHarness.agent.did.create({ store: true, method: 'jwk' });
      const { message } = await testHarness.agent.processDwnRequest({
        author        : delegateDid.uri,
        messageParams : { definition },
        messageType   : DwnInterface.ModulesConfigure,
        store         : false,
        target        : delegateDid.uri,
      });
      const delegateDwn = new DwnApi({
        agent        : testHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : delegateDid.uri,
      });

      const result = await delegateDwn.importModuleConfiguration(message!);
      const { modules } = await dwnAlice.modules.query({
        filter: { module: definition.module },
      });

      expect(result.status.code).toBeGreaterThanOrEqual(400);
      expect(result.module).toBeUndefined();
      expect(modules).toHaveLength(0);
    });
  });

  describe('TypedEnbox.records', () => {
    let typed: TypedEnbox<typeof TodoModuleDefinition, typeof TodoModule.codecs>;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoModule);

      // Install the module first
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    describe('configure()', () => {
      it('should configure the module on the local DWN', async () => {
        // Already configured in beforeEach — query to verify
        const { status, modules } = await dwnAlice.modules.query({
          filter: { module: TodoModule.definition.module },
        });
        expect(status.code).toBe(200);
        expect(modules).toHaveLength(1);
      });

      it('should skip re-configuration when the definition is unchanged', async () => {
        // Module was already configured in beforeEach.
        const { status, module } = await typed.configure();

        // Should return 200 (cached) instead of 202 (newly configured).
        expect(status.code).toBe(200);
        expect(module).toBeDefined();
        expect(module.definition.module).toBe(TodoModule.definition.module);
      });

      it('should re-configure when the definition changes', async () => {
        // Module was already configured in beforeEach with the original definition.
        // Create a new TypedEnbox with a modified definition (added a new type).
        const updatedDefinition = {
          ...TodoModuleDefinition,
          types: {
            ...TodoModuleDefinition.types,
            tag: {
              schema      : 'https://example.com/schemas/tag',
              dataFormats : ['application/json'] as const,
            },
          },
          structure: {
            ...TodoModuleDefinition.structure,
            list: {
              ...TodoModuleDefinition.structure.list,
              task: {
                ...TodoModuleDefinition.structure.list.task,
              },
            },
          },
        };

        const updatedModule = defineModule(updatedDefinition, TodoModule.codecs);
        const updatedTyped = new TypedEnbox(dwnAlice, updatedModule);

        const { status } = await updatedTyped.configure();

        // Should return 202 (newly configured) since the definition changed.
        expect(status.code).toBe(202);
      });
    });

    describe('create()', () => {
      it('should create and return the canonical Record', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Groceries', description: 'Weekly shopping' },
        });

        expect(record).toBeInstanceOf(Record);
        expect(record.modulePath).toBe('list');
        expect(record.schema).toBe('https://example.com/schemas/list');
        expect(record.module).toBe('https://example.com/modules/todo');
      });

      it('should write a record at a nested path', async () => {
        // First create a parent list
        const listRecord = await typed.records.create('list', {
          data: { name: 'Work Tasks' },
        });

        // Write a task nested under the list
        const taskRecord = await typed.records.create('list/task', {
          data            : { title: 'Review PR', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(taskRecord.modulePath).toBe('list/task');
        expect(taskRecord.schema).toBe('https://example.com/schemas/task');
      });

      it('should read back written JSON data via Record.value() without manual cast', async () => {
        const inputData = { name: 'Shopping', description: 'Grocery list' };
        const record = await typed.records.create('list', { data: inputData });

        // The module payload type is carried by Record<T>.
        const readBack = await record.value();
        expect(readBack.name).toBe('Shopping');
        expect(readBack.description).toBe('Grocery list');
      });

      it('should fail closed with module and record context for schema validation failures', async () => {
        const failure: RecordValidationFailure = {
          instancePath : '/name',
          keyword      : 'minLength',
          message      : 'must NOT have fewer than 1 characters',
          params       : { limit: 1 },
        };
        let rejectedName = '';
        const validator = Object.assign(
          (value: unknown): boolean => (value as { name?: unknown }).name !== rejectedName,
          { errors: [failure] },
        ) as RecordValidator;
        const validated = new TypedEnbox(dwnAlice, defineModule(TodoModuleDefinition, {
          ...TodoModule.codecs,
          list: recordCodecs.json<{ name: string }>({ validator }),
        }));

        await expect(validated.records.create('list', { data: { name: '' } })).rejects.toMatchObject({
          name       : 'RecordValidationError',
          modulePath : 'list',
          recordId   : undefined,
          schema     : TodoModuleDefinition.types.list.schema,
        });
        expect((await validated.records.query('list')).records).toHaveLength(0);

        const record = await validated.records.create('list', { data: { name: 'Valid' } });
        const invalidRecord = await validated.records.create('list', { data: { name: 'Invalid' } });
        rejectedName = 'Invalid';

        await expect(record.value()).resolves.toEqual({ name: 'Valid' });
        await expect(invalidRecord.value()).rejects.toMatchObject({
          name       : 'RecordValidationError',
          modulePath : 'list',
          recordId   : invalidRecord.id,
          schema     : TodoModuleDefinition.types.list.schema,
        });
        await expect(record.update({ data: { name: 'Invalid' } })).rejects.toMatchObject({
          name     : 'RecordValidationError',
          recordId : record.id,
        });

        await expect(validated.records.query('list', {
          materialize : true,
          pagination  : { limit: 10 },
        })).rejects.toMatchObject({
          name     : 'RecordValidationError',
          recordId : invalidRecord.id,
        });
        expect((await validated.records.query('list')).records).toHaveLength(2);
      });

      it('should use one custom codec across create, update, query, and read handles', async () => {
        const definition = {
          module    : 'https://example.com/modules/custom-codec',
          published : true,
          types     : {
            counter: { dataFormats: ['application/x-counter'] },
          },
          structure: { counter: {} },
        } as const satisfies ModuleDefinition;
        let encodeCalls = 0;
        let decodeCalls = 0;
        const codec: RecordCodec<number> = {
          encode(value: number): EncodedRecordData {
            encodeCalls += 1;
            return {
              data       : new Blob([`counter:${value}`]),
              dataFormat : 'application/x-counter',
            };
          },
          async decode(data, dataFormat): Promise<number> {
            decodeCalls += 1;
            expect(dataFormat).toBe('application/x-counter');
            return Number((await data.text()).slice('counter:'.length));
          },
        };
        const custom = new TypedEnbox(dwnAlice, defineModule(definition, { counter: codec }));

        const created = await custom.records.create('counter', { data: 1 });
        expect(await created.value()).toBe(1);
        await created.update({ data: 2 });

        const { records } = await custom.records.query('counter');
        expect(await records[0].value()).toBe(2);
        const read = await custom.records.read('counter', { filter: { recordId: created.id } });
        expect(await read!.value()).toBe(2);
        expect(encodeCalls).toBe(2);
        expect(decodeCalls).toBe(3);
      });

    });

    describe('create() with $squash (#972)', () => {
      // Self-contained module with a $squash path, so the shared Todo fixture is untouched.
      const SquashDefinition = {
        module    : 'https://example.com/modules/squash-test',
        published : true,
        types     : {
          doc      : { schema: 'https://example.com/schemas/doc', dataFormats: ['application/json'] },
          snapshot : { schema: 'https://example.com/schemas/snapshot', dataFormats: ['application/json'] },
        },
        structure: {
          doc: {
            $actions : [{ who: 'anyone', can: ['create', 'read'] }],
            snapshot : {
              $immutable : true,
              $squash    : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
            },
          },
        },
      } as const satisfies ModuleDefinition;

      const SquashModule = defineModule(SquashDefinition, {
        doc      : recordCodecs.json<{ n?: string }>(),
        snapshot : recordCodecs.json<{ v?: string }>(),
      });

      let squashed: TypedEnbox<typeof SquashDefinition, typeof SquashModule.codecs>;

      beforeEach(async () => {
        squashed = new TypedEnbox(dwnAlice, SquashModule);
        await squashed.configure();
      });

      it('forwards squash:true to the underlying write message descriptor', async () => {
        const doc = await squashed.records.create('doc', { data: { n: 'd' } });

        const record = await squashed.records.create('doc/snapshot', {
          data            : { v: 's1' },
          parentContextId : doc.contextId,
          squash          : true,
        });

        // If `squash` were dropped by the typed API, this would be an ordinary
        // (non-squashing) write — the descriptor would lack the directive.
        const descriptor = record.rawMessage.descriptor as { squash?: true };
        expect(descriptor.squash).toBe(true);
        expect(record.squash).toBe(true);
      });

      it('omits squash when not requested (no false-y field)', async () => {
        const doc = await squashed.records.create('doc', { data: { n: 'd2' } });
        const record = await squashed.records.create('doc/snapshot', {
          data            : { v: 's2' },
          parentContextId : doc.contextId,
        });
        const descriptor = record.rawMessage.descriptor as { squash?: true };
        expect(descriptor.squash).toBeUndefined();
        expect(record.squash).toBe(false);
      });

      it('compacts older siblings end-to-end — a squash write purges prior snapshots', async () => {
        const doc = await squashed.records.create('doc', { data: { n: 'doc' } });

        // two ordinary snapshots under the document context
        await squashed.records.create('doc/snapshot', { data: { v: 's1' }, parentContextId: doc.contextId });
        await new Promise((r) => setTimeout(r, 5)); // guarantee a distinct, later messageTimestamp
        await squashed.records.create('doc/snapshot', { data: { v: 's2' }, parentContextId: doc.contextId });
        await new Promise((r) => setTimeout(r, 5));

        // a squashing snapshot — must purge the two older siblings in this context
        const squashRecord = await squashed.records.create('doc/snapshot', {
          data            : { v: 's3' },
          parentContextId : doc.contextId,
          squash          : true,
        });

        // Only the squash record survives (this is the whole point of the flag reaching the write).
        // Queries on a nested module path must be scoped by the parent context
        // (dwn-sdk-js requires the parent contextId for nested-path queries — see #1043).
        const { records } = await squashed.records.query('doc/snapshot', {
          within: doc.contextId,
        });
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe(squashRecord.id);
      });

      it('throws a DwnResponseError when squash is rejected by the DWN', async () => {
        // `doc` has no $squash — the squash backstop must reject the write,
        // and a dynamically widened caller must preserve its machine-readable response.
        const dynamicCreate = squashed.records.create as (
          path: 'doc',
          request: { data: { n?: string }; squash: true },
        ) => Promise<Record<{ n?: string }>>;
        try {
          await dynamicCreate('doc', {
            data   : { n: 'nope' },
            squash : true,
          });
          throw new Error('expected create() to reject');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(DwnResponseError);
          expect((error as DwnResponseError).status.code).toBe(400);
          expect((error as DwnResponseError).status.detail).toContain('Squash');
        }
      });

      it('a squashing write still stores and reads back its data', async () => {
        const doc = await squashed.records.create('doc', { data: { n: 'doc' } });
        const record = await squashed.records.create('doc/snapshot', {
          data            : { v: 'payload' },
          parentContextId : doc.contextId,
          squash          : true,
        });

        const readBack = await record.value();
        expect(readBack.v).toBe('payload');
      });
    });

    describe('module role records', () => {
      const RoleDefinition = {
        module    : 'https://example.com/modules/typed-role-records',
        published : true,
        types     : {
          workspace : { dataFormats: ['application/json'] },
          member    : { dataFormats: ['application/json'] },
        },
        structure: {
          workspace: {
            member: { $role: true },
          },
        },
      } as const satisfies ModuleDefinition;
      const RoleModule = defineModule(RoleDefinition, {
        member    : recordCodecs.json<{ label: string }>(),
        workspace : recordCodecs.json<{ name: string }>(),
      });
      const DeliveryDefinition = {
        ...RoleDefinition,
        module : `${RoleDefinition.module}/delivery`,
        types  : {
          ...RoleDefinition.types,
          blind  : { dataFormats: ['application/json'] },
          member : { ...RoleDefinition.types.member, encryptionRequired: true },
          viewer : { dataFormats: ['application/json'] },
        },
        structure: {
          workspace: {
            $actions: [
              { role: 'workspace/member', can: ['read'] },
              { role: 'workspace/viewer', can: ['read'] },
            ],
            blind  : { $role: true },
            member : { $role: true },
            viewer : { $role: true },
          },
        },
      } as const satisfies ModuleDefinition;
      const DeliveryModule = defineModule(DeliveryDefinition, {
        ...RoleModule.codecs,
        blind  : recordCodecs.json<{ note: string }>(),
        viewer : recordCodecs.json<{ readonly: boolean }>(),
      });
      type DeliveryRole = 'workspace/member' | 'workspace/viewer';
      type DeliveryMembers = ContextMembersApi<
        typeof DeliveryDefinition,
        typeof DeliveryModule.codecs,
        DeliveryRole
      >;
      const recipient = 'did:example:bob';
      const createDeliveryMembers = async (): Promise<DeliveryMembers> => {
        const roleDelivery = {
          get       : sinon.stub().resolves({ state: 'delivered' as const }),
          retry     : sinon.stub().resolves({ state: 'delivered' as const }),
          subscribe : (): (() => void) => (): void => {},
        };
        const roles = new TypedEnbox(dwnAlice, DeliveryModule, { roleDelivery });
        await roles.configure();
        const workspace = await roles.records.create('workspace', { data: { name: 'Enbox' } });
        sinon.stub(testHarness.agent.dwn as any, 'provisionAudienceKeyDeliveryForReply').resolves({
          delivered    : false,
          failure      : 'awaiting-recipient-install',
          recipientDid : recipient,
          reason       : 'recipient module not installed',
        });
        return (await roles.contexts.open('workspace', workspace.contextId)).members;
      };
      const failRoleDeletion = (cause: Error, deleteFirst: boolean = false): void => {
        const deleteRecord = Record.prototype.delete;
        sinon.stub(Record.prototype, 'delete').callsFake(async function (
          this: Record,
          params?: RecordDeleteParams,
        ): Promise<void> {
          if (deleteFirst) {
            await deleteRecord.call(this, params);
          }
          throw cause;
        });
      };

      it('rejects a missing role recipient before issuing a DWN request', async () => {
        const roles = new TypedEnbox(dwnAlice, RoleModule);
        const processRequest = sinon.spy(testHarness.agent, 'processDwnRequest');
        const sendRequest = sinon.spy(testHarness.agent, 'sendDwnRequest');

        // @ts-expect-error intentionally bypass the public type to exercise the runtime boundary.
        await expect(roles.records.create('workspace/member', {
          data            : { label: 'member' },
          parentContextId : 'unused-context',
        })).rejects.toThrow('role path \'workspace/member\' requires a recipient');

        expect(processRequest.notCalled).toBe(true);
        expect(sendRequest.notCalled).toBe(true);
      });

      it('manages role assignments through ordinary typed Records operations', async () => {
        const roles = new TypedEnbox(dwnAlice, RoleModule);
        const configure = await roles.configure();
        expect(configure.status.code).toBe(202);

        const workspace = await roles.records.create('workspace', {
          data: { name: 'Enbox' },
        });
        const recipient = 'did:example:bob';
        const assignment = await roles.records.create('workspace/member', {
          data            : { label: 'maintainer' },
          parentContextId : workspace.contextId,
          recipient,
        });

        const listed = await roles.records.query('workspace/member', {
          filter : { recipient },
          within : workspace.contextId,
        });
        expect(listed.records.map(({ id }) => id)).toEqual([assignment.id]);

        try {
          await roles.records.create('workspace/member', {
            data            : { label: 'duplicate' },
            parentContextId : workspace.contextId,
            recipient,
          });
          throw new Error('expected duplicate role assignment to be rejected');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(DwnResponseError);
          expect((error as DwnResponseError).status.detail)
            .toContain(DwnErrorCode.ModuleAuthorizationDuplicateRoleRecipient);
        }

        await assignment.delete();
        const afterRevocation = await roles.records.query('workspace/member', {
          filter : { recipient },
          within : workspace.contextId,
        });
        expect(afterRevocation.records).toEqual([]);

        const reassigned = await roles.records.create('workspace/member', {
          data            : { label: 'maintainer' },
          parentContextId : workspace.contextId,
          recipient,
        });
        expect(reassigned.recipient).toBe(recipient);
      });

      it('manages encrypted context membership without exposing role records', async () => {
        const get = sinon.stub().resolves(undefined);
        const retry = sinon.stub().resolves({ state: 'delivered' as const });
        const roles = new TypedEnbox(dwnAlice, DeliveryModule, {
          roleDelivery: {
            get,
            retry,
            subscribe: (): (() => void) => {
              return (): void => {};
            },
          },
        });
        await roles.configure();

        const workspace = await roles.records.create('workspace', { data: { name: 'Enbox' } });
        const owned = await roles.contexts.open('workspace', workspace.contextId);
        const members = owned.members;
        sinon.stub(testHarness.agent.dwn as any, 'provisionAudienceKeyDeliveryForReply').resolves({
          delivered    : false,
          failure      : 'awaiting-recipient-install',
          recipientDid : recipient,
          reason       : 'recipient module not installed',
        });

        const assigned = await members.set(recipient, {
          data : { label: 'maintainer' },
          role : 'workspace/member',
        });
        expect(assigned).toMatchObject({
          data     : { label: 'maintainer' },
          did      : recipient,
          role     : 'workspace/member',
          delivery : {
            reason : 'recipient module not installed',
            state  : 'awaiting-recipient-install',
          },
        });
        expect(Object.keys(assigned).sort()).toEqual(['data', 'delivery', 'did', 'role']);
        expect(get.notCalled).toBe(true);

        await roles.records.create('workspace/viewer', {
          data            : { readonly: true },
          parentContextId : workspace.contextId,
          recipient,
        });
        expect((await members.get(recipient))?.role).toBe('workspace/member');

        const changed = await members.set(recipient, {
          data : { readonly: true },
          role : 'workspace/viewer',
        });
        expect(changed).toMatchObject({
          data     : { readonly: true },
          did      : recipient,
          role     : 'workspace/viewer',
          delivery : { state: 'pending' },
        });
        expect((await members.list()).map(member => member.did)).toEqual([recipient]);

        expect(await members.retryDelivery(recipient)).toMatchObject({ delivery: { state: 'delivered' } });
        expect(retry.calledOnce).toBe(true);

        await members.remove(recipient);
        await members.remove(recipient);
        expect(await members.get(recipient)).toBeUndefined();
        await expect(members.set('not-a-did', {
          data : { label: 'invalid' },
          role : 'workspace/member',
        })).rejects.toThrow('is not a DID');
      }, 15000);

      it('returns a role change when cleanup fails after the requested role becomes effective', async () => {
        const members = await createDeliveryMembers();
        await members.set(recipient, {
          data : { readonly: true },
          role : 'workspace/viewer',
        });
        const cleanupError = new Error('viewer cleanup failed');
        failRoleDeletion(cleanupError);

        const changed = await members.set(recipient, {
          data : { label: 'maintainer' },
          role : 'workspace/member',
        });

        expect(changed).toMatchObject({ did: recipient, role: 'workspace/member' });
        expect((await members.get(recipient))?.role).toBe('workspace/member');
      }, 15000);

      it('makes an incomplete role change retryable when the previous stronger role remains effective', async () => {
        const members = await createDeliveryMembers();
        await members.set(recipient, {
          data : { label: 'maintainer' },
          role : 'workspace/member',
        });
        const cleanupError = new Error('member cleanup failed');
        failRoleDeletion(cleanupError);

        const error = await members.set(recipient, {
          data : { readonly: true },
          role : 'workspace/viewer',
        }).then(() => undefined, reason => reason as Error);

        expect(error).toBeInstanceOf(ContextNotReadyError);
        expect(error?.cause).toBe(cleanupError);
        expect((await members.get(recipient))?.role).toBe('workspace/member');
      }, 15000);

      it('accepts a failed removal only when its reread proves the member absent', async () => {
        const members = await createDeliveryMembers();
        await members.set(recipient, {
          data : { label: 'maintainer' },
          role : 'workspace/member',
        });
        failRoleDeletion(new Error('delete response was lost'), true);

        await expect(members.remove(recipient)).resolves.toBeUndefined();
        expect(await members.get(recipient)).toBeUndefined();
      }, 15000);

      it('makes a failed removal retryable while the member remains effective', async () => {
        const members = await createDeliveryMembers();
        await members.set(recipient, {
          data : { label: 'maintainer' },
          role : 'workspace/member',
        });
        const cleanupError = new Error('member removal failed');
        failRoleDeletion(cleanupError);

        const error = await members.remove(recipient).then(() => undefined, reason => reason as Error);

        expect(error).toBeInstanceOf(ContextNotReadyError);
        expect(error?.cause).toBe(cleanupError);
        expect((await members.get(recipient))?.role).toBe('workspace/member');
      }, 15000);
    });

    describe('query()', () => {
      it('should query canonical Record instances', async () => {
        // Write two lists
        await typed.records.create('list', { data: { name: 'List A' } });
        await typed.records.create('list', { data: { name: 'List B' } });

        const { records } = await typed.records.query('list');

        expect(records).toHaveLength(2);
        expect(records[0]).toBeInstanceOf(Record);
      });

      it('should apply additional filters', async () => {
        const listRecord = await typed.records.create('list', {
          data: { name: 'Work' },
        });

        // Write tasks under the list
        await typed.records.create('list/task', {
          data            : { title: 'Task 1', completed: false },
          parentContextId : listRecord.contextId,
        });
        await typed.records.create('list/task', {
          data            : { title: 'Task 2', completed: true },
          parentContextId : listRecord.contextId,
        });

        // Query tasks under this specific list context
        const { records } = await typed.records.query('list/task', {
          within: listRecord.contextId,
        });

        expect(records).toHaveLength(2);
      });

      it('should read typed data from queried Records without manual cast', async () => {
        await typed.records.create('list', { data: { name: 'Query Test' } });

        const { records } = await typed.records.query('list');
        expect(records.length).toBeGreaterThanOrEqual(1);

        // value() decodes the typed application value directly.
        const data = await records[0].value();
        expect(data.name).toBe('Query Test');
      });
    });

    describe('count()', () => {
      it('should count the same population before pagination', async () => {
        await typed.records.create('list', { data: { name: 'Private' } });
        await typed.records.create('list', { data: { name: 'Published A' }, published: true });
        await typed.records.create('list', { data: { name: 'Published B' }, published: true });

        const publishedSpec = {
          dateSort   : DateSort.PublishedAscending,
          pagination : { limit: 1 },
        };
        const { records } = await typed.records.query('list', publishedSpec);
        const count = await typed.records.count('list', publishedSpec);

        expect(records).toHaveLength(1);
        expect(count).toBe(2);

        const all = await typed.records.count('list', { pagination: { limit: 1 } });
        expect(all).toBe(3);
      });
    });

    describe('read()', () => {
      it('should read a single record by recordId and return the canonical Record', async () => {
        const written = await typed.records.create('list', {
          data: { name: 'Reading List' },
        });

        const readRecord = await typed.records.read('list', written.id);

        expect(readRecord).toBeInstanceOf(Record);
        const data = await readRecord!.value();
        expect(data.name).toBe('Reading List');
      });
    });

    describe('delete()', () => {
      it('should delete a record by recordId', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'To Delete' },
        });

        await typed.records.delete('list', {
          recordId: record.id,
        });

        // Verify it's gone
        const { records } = await typed.records.query('list');
        expect(records).toHaveLength(0);
      });
    });

    describe('schema-less types', () => {
      it('should write and query a type that has no schema (only dataFormats)', async () => {
        // Create a parent list and task for the attachment to nest under.
        const listRecord = await typed.records.create('list', {
          data: { name: 'Attachments Test' },
        });

        const taskRecord = await typed.records.create('list/task', {
          data            : { title: 'Task with attachment', completed: false },
          parentContextId : listRecord.contextId,
        });

        // Write a binary attachment — the 'attachment' type has no schema,
        // only dataFormats: ['application/octet-stream', 'image/png', 'image/jpeg'].
        const blob = new Blob(['binary-content'], { type: 'application/octet-stream' });
        const attachmentRecord = await typed.records.create(
          'list/task/attachment',
          {
            data            : blob,
            parentContextId : taskRecord.contextId,
          },
        );

        expect(attachmentRecord.modulePath).toBe('list/task/attachment');
        // Schema should be undefined — not set on the record.
        expect(attachmentRecord.schema).toBeUndefined();

        // Query should also succeed without schema: undefined in the filter.
        const { records } = await typed.records.query(
          'list/task/attachment',
          { within: taskRecord.contextId },
        );

        expect(records).toHaveLength(1);
        expect(records[0].id).toBe(attachmentRecord.id);
      });
    });



    describe('auto-configure on first operation', () => {
      it('should auto-configure and succeed when calling create() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);

        const record = await unconfigured.records.create('list', {
          data: { name: 'Auto-configured' },
        });

        expect(record.modulePath).toBe('list');
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling query() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);

        const { records } = await unconfigured.records.query('list');

        expect(records).toEqual([]);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling read() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);

        // Create a record first via auto-configure, then read it back
        const created = await unconfigured.records.create('list', {
          data: { name: 'Read Test' },
        });

        const record = await unconfigured.records.read('list', {
          filter: { recordId: created.id },
        });

        expect(record?.id).toBe(created.id);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling delete() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);

        // Create a record first via auto-configure, then delete it
        const created = await unconfigured.records.create('list', {
          data: { name: 'Delete Test' },
        });

        await unconfigured.records.delete('list', {
          recordId: created.id,
        });

        expect(await unconfigured.records.read('list', { filter: { recordId: created.id } })).toBeUndefined();
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should install the module transparently on first operation', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);

        // Perform an operation without explicit configure()
        await unconfigured.records.create('list', { data: { name: 'Transparent' } });

        // Verify the module was installed
        const { modules } = await dwnAlice.modules.query({
          filter: { module: TodoModule.definition.module },
        });
        expect(modules).toHaveLength(1);
      });
    });

    describe('error paths', () => {
      it('should throw on invalid module path', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('invalid module path');
      });

      it('should include valid paths in the invalid path error message', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('Valid paths are:');
      });

      it('should throw on invalid nested path', async () => {
        await expect(
          typed.records.query('list/nonexistent' as any),
        ).rejects.toThrow('invalid module path');
      });

      it('should report isConfigured as false before configure()', () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoModule);
        expect(unconfigured.isConfigured).toBe(false);
      });

      it('should report isConfigured as true after configure()', () => {
        // `typed` is configured in beforeEach
        expect(typed.isConfigured).toBe(true);
      });

      it('should normalize trailing slashes on create()', async () => {
        const record = await typed.records.create('list/' as any, {
          data: { name: 'Trailing Slash' },
        });

        expect(record.modulePath).toBe('list');
      });

      it('should normalize trailing slashes on query()', async () => {
        await typed.records.create('list', { data: { name: 'Slash Test' } });

        const { records } = await typed.records.query('list/' as any);
        expect(records.length).toBeGreaterThanOrEqual(1);
      });

      it('should normalize leading slashes', async () => {
        const record = await typed.records.create('/list' as any, {
          data: { name: 'Leading Slash' },
        });

        expect(record.modulePath).toBe('list');
      });

      it('should normalize nested paths with trailing slashes', async () => {
        const listRecord = await typed.records.create('list', {
          data: { name: 'Nested Slash Test' },
        });

        const record = await typed.records.create('list/task/' as any, {
          data            : { title: 'Slashed Task', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(record.modulePath).toBe('list/task');
      });
    });

    describe('helper functions (via public API)', () => {
      describe('module definition comparison', () => {
        it('should detect equal definitions with different key ordering', async () => {
          // Create a module with the same fields but potentially different order.
          // The first configure() stores the definition. A second configure() with an
          // identical definition (same fields, same values) should return 200 (cached).
          const result = await typed.configure();
          expect(result.status.code).toBe(200); // already configured in beforeEach
          expect(result.module).toBeDefined();
        });

        it('should detect unequal definitions with added types', async () => {
          // Modify the definition by adding a new type.
          const modifiedDefinition = {
            ...TodoModuleDefinition,
            types: {
              ...TodoModuleDefinition.types,
              note: {
                schema      : 'https://example.com/schemas/note',
                dataFormats : ['application/json'] as const,
              },
            },
            structure: {
              ...TodoModuleDefinition.structure,
            },
          };

          const modifiedModule = defineModule(modifiedDefinition, TodoModule.codecs);
          const modifiedTyped = new TypedEnbox(dwnAlice, modifiedModule);

          const result = await modifiedTyped.configure();
          // Should return 202 because the definition changed (new type added).
          expect(result.status.code).toBe(202);
        });

      });

      describe('normalizePath()', () => {
        it('should normalize leading slashes on read()', async () => {
          const written = await typed.records.create('list', {
            data: { name: 'Normalize Read' },
          });

          const record = await typed.records.read('/list' as any, {
            filter: { recordId: written.id },
          });

          expect(record?.modulePath).toBe('list');
        });

        it('should normalize leading and trailing slashes on delete()', async () => {
          const written = await typed.records.create('list', {
            data: { name: 'Normalize Delete' },
          });

          await typed.records.delete('/list/' as any, {
            recordId: written.id,
          });

          expect(await typed.records.read('list', { filter: { recordId: written.id } })).toBeUndefined();
        });

        it('should forward the normalized path as delete grant-resolution metadata', async () => {
          const deleteRecord = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
          const dwn = {
            isDelegate : false,
            modules    : {
              query: sinon.stub().resolves({
                modules : [{ definition: TodoModuleDefinition }],
                status  : { code: 200, detail: 'OK' },
              }),
            },
            records: { delete: deleteRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoModule);

          await scopedTyped.records.delete('/list/' as any, {
            from       : 'did:example:remote',
            moduleRole : 'list/editor',
            recordId   : 'record-id',
            within     : 'listcontext',
          });

          expect(deleteRecord.calledOnceWithExactly({
            contextId  : 'listcontext',
            from       : 'did:example:remote',
            module     : TodoModuleDefinition.module,
            modulePath : 'list',
            moduleRole : 'list/editor',
            recordId   : 'record-id',
            prune      : undefined,
          })).toBe(true);
        });

        it('should forward within through the canonical read filter', async () => {
          const readRecord = sinon.stub().resolves({ status: { code: 404, detail: 'Not Found' } });
          const dwn = {
            isDelegate : false,
            modules    : {
              query: sinon.stub().resolves({
                modules : [{ definition: TodoModuleDefinition }],
                status  : { code: 200, detail: 'OK' },
              }),
            },
            records: { read: readRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoModule);

          const result = await scopedTyped.records.read('/list/' as any, {
            filter     : { recordId: 'record-id' },
            from       : 'did:example:remote',
            moduleRole : 'list/viewer',
            within     : 'listcontext',
          });

          expect(result).toBeUndefined();
          expect(readRecord.calledOnceWithExactly({
            from       : 'did:example:remote',
            moduleRole : 'list/viewer',
            filter     : {
              contextId  : 'listcontext',
              module     : TodoModuleDefinition.module,
              modulePath : 'list',
              recordId   : 'record-id',
              schema     : TodoModuleDefinition.types.list.schema,
            },
          })).toBe(true);
        });

        it('should reject invalid and retired delete context selectors', async () => {
          const deleteRecord = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
          const dwn = {
            isDelegate : false,
            modules    : {
              query: sinon.stub().resolves({
                modules : [{ definition: TodoModuleDefinition }],
                status  : { code: 200, detail: 'OK' },
              }),
            },
            records: { delete: deleteRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoModule);

          await expect(scopedTyped.records.delete('list', {
            recordId : 'record-id',
            within   : '',
          })).rejects.toThrow('Record scope: within must be at most 600 characters');
          await expect(scopedTyped.records.delete('list', {
            recordId  : 'record-id',
            contextId : 'listcontext',
          } as never)).rejects.toThrow('TypedDeleteRequest: use within instead of contextId');

          expect(deleteRecord.called).toBe(false);
        });

      });

      describe('module-path type resolution', () => {
        it('should resolve schema from the last segment of a nested path', async () => {
          // Create a parent list first.
          const listRecord = await typed.records.create('list', {
            data: { name: 'LastSegment Test' },
          });

          // The final `task` path segment resolves to the task schema.
          const record = await typed.records.create('list/task', {
            data            : { title: 'Deep task', completed: false },
            parentContextId : listRecord.contextId,
          });

          expect(record.schema).toBe('https://example.com/schemas/task');
        });

        it('should resolve schema from deeply nested path', async () => {
          const listRecord = await typed.records.create('list', {
            data: { name: 'Deep Nest' },
          });
          const taskRecord = await typed.records.create('list/task', {
            data            : { title: 'Parent task', completed: false },
            parentContextId : listRecord.contextId,
          });

          // The final `attachment` path segment resolves to the schema-less attachment type.
          const blob = new Blob(['content'], { type: 'application/octet-stream' });
          const record = await typed.records.create('list/task/attachment', {
            data            : blob,
            parentContextId : taskRecord.contextId,
          });

          expect(record.schema).toBeUndefined();
        });
      });

      describe('collectPaths()', () => {
        it('should recognize all valid paths from the module structure', async () => {
          // Verify all expected paths are valid by performing operations on them.
          // If collectPaths is wrong, _assertReady would throw 'invalid module path'.
          const listRecord = await typed.records.create('list', {
            data: { name: 'Path Test' },
          });
          const taskRecord = await typed.records.create('list/task', {
            data            : { title: 'Path task', completed: false },
            parentContextId : listRecord.contextId,
          });

          const lists = await typed.records.query('list');
          expect(lists.records.some((record) => record.id === listRecord.id)).toBe(true);

          const tasks = await typed.records.query('list/task', {
            within: listRecord.contextId,
          });
          expect(tasks.records.some((record) => record.id === taskRecord.id)).toBe(true);

          const attachments = await typed.records.query('list/task/attachment', {
            within: taskRecord.contextId,
          });
          expect(attachments.records).toEqual([]);
        });

        it('should reject paths not in the collected set', async () => {
          await expect(
            typed.records.query('unknown' as any),
          ).rejects.toThrow('invalid module path');
        });

        it('should skip $-prefixed keys in the structure', async () => {
          // $actions is a key in the module structure but should not be a valid path.
          await expect(
            typed.records.query('list/$actions' as any),
          ).rejects.toThrow('invalid module path');
        });
      });
    });

    describe('Record lifecycle methods', () => {
      it('should update and return the same canonical Record', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Original' },
        });
        const updatedRecord = await record.update({
          data: { name: 'Updated', description: 'Now with description' },
        });

        expect(updatedRecord).toBeInstanceOf(Record);
        expect(updatedRecord).toBe(record);
        const data = await updatedRecord.value();
        expect(data.name).toBe('Updated');
        expect(data.description).toBe('Now with description');
      });

      it('should reject a data format override through a record handle', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Codec-owned format' },
        });

        await expect(record.update({
          data       : { name: 'Still codec-owned' },
          dataFormat : 'text/plain',
        } as never)).rejects.toThrow('dataFormat cannot be changed through a record handle');
      });

      it('should delete a record in place', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Delete Me' },
        });
        expect(record.deleted).toBe(false);

        const result = await record.delete();

        expect(result).toBeUndefined();
        expect(record.deleted).toBe(true);
      });

      it('should serialize the canonical Record with toJSON()', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'JSON Test' },
        });

        const json = record.toJSON();
        expect(json.module).toBe('https://example.com/modules/todo');
        expect(json.modulePath).toBe('list');
      });

      it('should format the canonical Record with toString()', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'String Test' },
        });

        const str = record.toString();
        expect(str).toContain('Record:');
        expect(str).toContain(record.id);
      });
    });

    describe('value and error contract', () => {
      it('create() returns a typed Record directly', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Type Safety Test' },
        });

        expect(record).toBeInstanceOf(Record);
        expect(await record.value()).toEqual({ name: 'Type Safety Test' });
      });

      it('create() throws DwnResponseError with the original status on failure', async () => {
        // Stub the agent to return a non-2xx status for the write operation.
        // DwnApi.records is a getter that returns a fresh object, so we stub
        // at the agent level instead.
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply: {
            status: {
              code      : 400,
              detail    : 'Bad Request',
              errorCode : 'RecordsWriteRejected',
              info      : { field: 'data' },
            },
          },
          message: {} as never,
        } as never);

        try {
          await typed.records.create('list', { data: { name: 'Should Fail' } });
          throw new Error('expected create() to reject');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(DwnResponseError);
          expect((error as DwnResponseError).status).toEqual({
            code      : 400,
            detail    : 'Bad Request',
            errorCode : 'RecordsWriteRejected',
            info      : { field: 'data' },
          });
          expect((error as DwnResponseError).message).toBe(
            'TypedEnbox.records.create failed (400): Bad Request'
          );
        } finally {
          processStub.restore();
        }
      });

      it('preserves errors thrown before a DWN response exists', async () => {
        const reason = new Error('transport unavailable');
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').rejects(reason);

        try {
          await expect(typed.records.create('list', {
            data: { name: 'Never dispatched' },
          })).rejects.toBe(reason);
        } finally {
          processStub.restore();
        }
      });

      it('read() returns a typed Record on success', async () => {
        const created = await typed.records.create('list', {
          data: { name: 'Read Target' },
        });

        const record = await typed.records.read('list', {
          filter: { recordId: created.id },
        });

        expect(record).toBeInstanceOf(Record);
        expect(await record!.value()).toEqual({ name: 'Read Target' });
      });

      it('read() returns undefined when no current record exists', async () => {
        // Stub at the agent level — DwnApi.records is a getter that
        // returns a fresh object, so direct stubbing doesn't work.
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply   : { status: { code: 404, detail: 'Not Found' }, entry: {} },
          message : {} as never,
        } as never);

        const record = await typed.records.read('list', {
          filter: { recordId: 'nonexistent-id' },
        });

        expect(record).toBeUndefined();

        processStub.restore();
      });

      it('read() throws for failures other than not found', async () => {
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply   : { status: { code: 401, detail: 'Unauthorized' }, entry: {} },
          message : {} as never,
        } as never);

        try {
          await typed.records.read('list', {
            filter: { recordId: 'unauthorized-id' },
          });
          throw new Error('expected read() to reject');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(DwnResponseError);
          expect((error as DwnResponseError).status).toEqual({ code: 401, detail: 'Unauthorized' });
        } finally {
          processStub.restore();
        }
      });

      it('count() returns a number directly', async () => {
        await typed.records.create('list', {
          data: { name: 'Counted' },
        });

        expect(await typed.records.count('list')).toBe(1);
      });

      it('count() rejects a successful reply that omits the count', async () => {
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply   : { status: { code: 200, detail: 'OK' } },
          message : {} as never,
        } as never);

        try {
          await expect(typed.records.count('list')).rejects.toThrow(
            'TypedEnbox.records.count: DWN returned success without a count.'
          );
        } finally {
          processStub.restore();
        }
      });

      it('query(), count(), and delete() translate non-success replies', async () => {
        const operations = [
          { name: 'query', run: async (): Promise<unknown> => typed.records.query('list') },
          { name: 'count', run: async (): Promise<unknown> => typed.records.count('list') },
          { name: 'delete', run: async (): Promise<unknown> => typed.records.delete('list', { recordId: 'record-id' }) },
        ];

        for (const operation of operations) {
          const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
            reply   : { status: { code: 403, detail: 'Forbidden' } },
            message : {} as never,
          } as never);

          try {
            await operation.run();
            throw new Error(`expected ${operation.name}() to reject`);
          } catch (error: unknown) {
            expect(error).toBeInstanceOf(DwnResponseError);
            expect((error as DwnResponseError).status).toEqual({ code: 403, detail: 'Forbidden' });
          } finally {
            processStub.restore();
          }
        }
      });

      it('delete() resolves without a response envelope and removes the record', async () => {
        const record = await typed.records.create('list', {
          data: { name: 'Delete Contract' },
        });

        const result = await typed.records.delete('list', { recordId: record.id });

        expect(result).toBeUndefined();
        expect(await typed.records.read('list', { filter: { recordId: record.id } })).toBeUndefined();
      });
    });
  });
});
