import type { BearerDid } from '@enbox/dids';
import type { ContextMembersApi } from '../src/typed-enbox.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
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
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { Protocol } from '../src/protocol.js';
import { Record } from '../src/record.js';
import { recordCodecs } from '../src/record-codec.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { CONTEXT_INVITATION_PATH, contextInvitationCodec } from '../src/context-invitations.js';
import { DateSort, DwnErrorCode } from '@enbox/dwn-sdk-js';
import { defineProtocol, isTypedProtocol } from '../src/define-protocol.js';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

// ---------------------------------------------------------------------------
// Test protocol definition
// ---------------------------------------------------------------------------

const TodoProtocolDefinition = {
  protocol  : 'https://example.com/protocols/todo',
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
} as const satisfies ProtocolDefinition;

const TodoProtocol = defineProtocol(TodoProtocolDefinition, {
  attachment : recordCodecs.blob(),
  list       : recordCodecs.json<{ name: string; description?: string }>(),
  task       : recordCodecs.json<{ title: string; completed: boolean }>(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('TypedProtocol API', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/typed-protocol',
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

  describe('defineProtocol()', () => {
    const RoleGroupDefinition = {
      protocol  : 'https://example.com/protocols/role-groups',
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
    } as const satisfies ProtocolDefinition;
    const RoleGroupCodecs = {
      blind     : recordCodecs.json<unknown>(),
      member    : recordCodecs.json<unknown>(),
      note      : recordCodecs.json<unknown>(),
      outsider  : recordCodecs.json<unknown>(),
      project   : recordCodecs.json<unknown>(),
      viewer    : recordCodecs.json<unknown>(),
      workspace : recordCodecs.json<unknown>(),
    };
    const defineRoleGroups = (roleGroups: unknown): {
      codecs: globalThis.Record<string, RecordCodec<unknown>>;
      definition: ProtocolDefinition;
      roleGroups: Readonly<globalThis.Record<string, readonly string[]>>;
    } => (defineProtocol as unknown as (
      definition: ProtocolDefinition,
      codecs: typeof RoleGroupCodecs,
      options: { roleGroups: unknown },
    ) => {
      codecs: globalThis.Record<string, RecordCodec<unknown>>;
      definition: ProtocolDefinition;
      roleGroups: Readonly<globalThis.Record<string, readonly string[]>>;
    })(RoleGroupDefinition, RoleGroupCodecs, { roleGroups });

    it('should return a TypedProtocol with the original definition', () => {
      expect(TodoProtocol.definition).toBe(TodoProtocolDefinition);
      expect(TodoProtocol.definition.protocol).toBe('https://example.com/protocols/todo');
    });

    it('should preserve the types and structure', () => {
      expect(TodoProtocol.definition.types.list.schema).toBe('https://example.com/schemas/list');
      expect(TodoProtocol.definition.structure.list).toBeDefined();
    });

    it('should reject missing, unexpected, and invalid runtime codecs', () => {
      const missing = { ...TodoProtocol.codecs } as Partial<typeof TodoProtocol.codecs>;
      delete missing.attachment;
      expect(() => defineProtocol(TodoProtocolDefinition, missing as typeof TodoProtocol.codecs))
        .toThrow('missing: attachment');

      const unexpected = { ...TodoProtocol.codecs, orphan: recordCodecs.json<unknown>() };
      expect(() => defineProtocol(
        TodoProtocolDefinition,
        unexpected as unknown as typeof TodoProtocol.codecs,
      )).toThrow('unexpected: orphan');

      const invalid = { ...TodoProtocol.codecs, task: {} };
      expect(() => defineProtocol(
        TodoProtocolDefinition,
        invalid as unknown as typeof TodoProtocol.codecs,
      )).toThrow('invalid: task');
    });

    it('validates context role groups once at the protocol boundary', () => {
      const invalid: Array<[unknown, string]> = [
        [{ viewers: ['workspace/viewer'] }, 'must declare a \'default\' group'],
        [{ default: [] }, 'must contain at least one role path'],
        [{ default: ['workspace/member', 'workspace/member'] }, 'must not contain duplicate roles'],
        [{ default: ['workspace/note'] }, 'role \'workspace/note\' is not an encrypted audience'],
        [{ default: ['workspace/blind'] }, 'must authorize reading its parent context \'workspace\''],
        [{ default: ['workspace/member', 'project/outsider'] }, 'roles must share one context root'],
      ];

      for (const [roleGroups, message] of invalid) {
        expect(() => defineRoleGroups(roleGroups)).toThrow(message);
      }
    });

    it('copies role precedence and adds one isolated invitation inbox without mutating authored inputs', () => {
      const roles = ['workspace/member', 'workspace/viewer'];
      const input = { default: roles };
      const protocol = defineRoleGroups(input);

      roles.reverse();
      expect(protocol.definition).not.toBe(RoleGroupDefinition);
      expect(RoleGroupDefinition.types).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(RoleGroupDefinition.structure).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(RoleGroupCodecs).not.toHaveProperty(CONTEXT_INVITATION_PATH);
      expect(protocol.definition.types[CONTEXT_INVITATION_PATH]).toMatchObject({
        dataFormats : ['application/json'],
        schema      : 'https://enbox.id/schemas/context-invitation',
      });
      expect(protocol.definition.structure[CONTEXT_INVITATION_PATH]).toEqual({
        $actions   : [{ who: 'anyone', can: ['create'] }],
        $immutable : true,
        $size      : { max: 8_192 },
      });
      expect(protocol.codecs[CONTEXT_INVITATION_PATH]).toBe(contextInvitationCodec);
      expect(protocol.roleGroups).not.toBe(input);
      expect(protocol.roleGroups.default).not.toBe(roles);
      expect(protocol.roleGroups.default).toEqual(['workspace/member', 'workspace/viewer']);
      expect(Object.isFrozen(protocol.roleGroups)).toBe(true);
      expect(Object.isFrozen(protocol.roleGroups.default)).toBe(true);
      expect(isTypedProtocol(protocol)).toBe(true);

      const other = defineRoleGroups({ default: ['workspace/member'] });
      expect(other.definition.types[CONTEXT_INVITATION_PATH])
        .not.toBe(protocol.definition.types[CONTEXT_INVITATION_PATH]);
      expect(other.definition.structure[CONTEXT_INVITATION_PATH])
        .not.toBe(protocol.definition.structure[CONTEXT_INVITATION_PATH]);
    });

    it('derives the managed invitation inbox from the protocol definition instead of role groups', () => {
      const withoutRoleGroups = defineProtocol(RoleGroupDefinition, RoleGroupCodecs);
      const withRoleGroups = defineRoleGroups({ default: ['workspace/member'] });

      expect(withoutRoleGroups.definition).toEqual(withRoleGroups.definition);
      expect(withoutRoleGroups.codecs).toEqual(withRoleGroups.codecs);
      expect(withoutRoleGroups.roleGroups).toEqual({});
      expect(isTypedProtocol(withoutRoleGroups)).toBe(true);
      expect(new TypedEnbox(dwnAlice, withoutRoleGroups).contexts).not.toHaveProperty('invitations');
      expect(new TypedEnbox(dwnAlice, withRoleGroups).contexts).toHaveProperty('invitations');
      expect(isTypedProtocol({
        definition : RoleGroupDefinition,
        codecs     : RoleGroupCodecs,
        roleGroups : {},
      })).toBe(false);
    });

    it('rejects managed invitation fragments with altered semantics', () => {
      const protocol = defineRoleGroups({ default: ['workspace/member'] });
      const type = protocol.definition.types[CONTEXT_INVITATION_PATH];
      const rule = protocol.definition.structure[CONTEXT_INVITATION_PATH];

      expect(isTypedProtocol({
        ...protocol,
        definition: {
          ...protocol.definition,
          types: { ...protocol.definition.types, [CONTEXT_INVITATION_PATH]: { ...type, encryptionRequired: true } },
        },
      })).toBe(false);
      expect(isTypedProtocol({
        ...protocol,
        definition: {
          ...protocol.definition,
          structure: { ...protocol.definition.structure, [CONTEXT_INVITATION_PATH]: { ...rule, $role: true } },
        },
      })).toBe(false);
    });

    it('reserves the invitation type name at the protocol boundary', () => {
      for (const property of ['types', 'structure'] as const) {
        const definition = {
          ...TodoProtocolDefinition,
          [property]: {
            ...TodoProtocolDefinition[property],
            [CONTEXT_INVITATION_PATH]: {},
          },
        } as unknown as typeof TodoProtocolDefinition;
        expect(() => defineProtocol(definition, TodoProtocol.codecs)).toThrow(
          `'${CONTEXT_INVITATION_PATH}' is reserved for shared-context invitations`,
        );
      }
    });
  });

  describe('TypedEnbox', () => {
    it('should be constructable from a DwnApi and TypedProtocol', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed).toBeInstanceOf(TypedEnbox);
    });

    it('should expose the protocol URI', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed.protocol).toBe('https://example.com/protocols/todo');
    });

    it('should expose the protocol definition', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed.definition).toBe(TodoProtocolDefinition);
    });

    it('should return the same records object on repeated access', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const records1 = typed.records;
      const records2 = typed.records;
      expect(records1).toBe(records2);
    });

    it('should import the wallet-owned protocol configuration when configuring as a delegate', async () => {
      const protocolsConfigureMessage = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : TodoProtocolDefinition,
        },
      };
      const remoteProtocol = {
        definition : TodoProtocolDefinition,
        toJSON     : (): typeof protocolsConfigureMessage => protocolsConfigureMessage,
      };
      const query = sinon.stub();
      query.resolves({ status: { code: 200, detail: 'OK' }, protocols: [remoteProtocol] });
      const importProtocolConfiguration = sinon.stub().resolves({
        status   : { code: 202, detail: 'Accepted' },
        protocol : remoteProtocol,
      });

      const delegateDwn = {
        connectedDid : aliceDid.uri,
        isDelegate   : true,
        protocols    : { query },
        importProtocolConfiguration,
      } as unknown as DwnApi;

      const typed = new TypedEnbox(delegateDwn, TodoProtocol);
      const result = await typed.configure();

      expect(result.status.code).toBe(202);
      expect(importProtocolConfiguration.calledOnceWith(protocolsConfigureMessage)).toBe(true);
      expect(query.firstCall.args[0]).toEqual({
        from   : aliceDid.uri,
        filter : { protocol: TodoProtocolDefinition.protocol },
      });
      expect(query.secondCall.args[0]).toEqual({ filter: { protocol: TodoProtocolDefinition.protocol } });
    });

    it('should import a signed wallet protocol configuration through Protocol.toJSON()', async () => {
      const definition = {
        ...TodoProtocolDefinition,
        protocol: `https://example.com/protocols/delegate-import/${crypto.randomUUID()}`,
      };
      const { message } = await testHarness.agent.processDwnRequest({
        author        : aliceDid.uri,
        messageParams : { definition },
        messageType   : DwnInterface.ProtocolsConfigure,
        store         : false,
        target        : aliceDid.uri,
      });
      const remoteProtocol = new Protocol(message!);
      const delegateDid = await testHarness.agent.did.create({ store: true, method: 'jwk' });
      const delegateDwn = new DwnApi({
        agent        : testHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : delegateDid.uri,
      });

      const result = await delegateDwn.importProtocolConfiguration(remoteProtocol.toJSON());
      const duplicateResult = await delegateDwn.importProtocolConfiguration(remoteProtocol.toJSON());
      const { protocols } = await dwnAlice.protocols.query({
        filter: { protocol: definition.protocol },
      });

      expect(result.status.code).toBe(202);
      expect(duplicateResult.status.code).toBe(409);
      expect(duplicateResult.protocol?.definition.protocol).toBe(definition.protocol);
      expect(protocols).toHaveLength(1);
      expect(protocols[0].definition.protocol).toBe(definition.protocol);
    });

    it('should reject delegate-signed protocol configurations imported into the owner tenant', async () => {
      const definition = {
        ...TodoProtocolDefinition,
        protocol: `https://example.com/protocols/delegate-import/${crypto.randomUUID()}`,
      };
      const delegateDid = await testHarness.agent.did.create({ store: true, method: 'jwk' });
      const { message } = await testHarness.agent.processDwnRequest({
        author        : delegateDid.uri,
        messageParams : { definition },
        messageType   : DwnInterface.ProtocolsConfigure,
        store         : false,
        target        : delegateDid.uri,
      });
      const delegateDwn = new DwnApi({
        agent        : testHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : delegateDid.uri,
      });

      const result = await delegateDwn.importProtocolConfiguration(message!);
      const { protocols } = await dwnAlice.protocols.query({
        filter: { protocol: definition.protocol },
      });

      expect(result.status.code).toBeGreaterThanOrEqual(400);
      expect(result.protocol).toBeUndefined();
      expect(protocols).toHaveLength(0);
    });
  });

  describe('TypedEnbox.records', () => {
    let typed: TypedEnbox<typeof TodoProtocolDefinition, typeof TodoProtocol.codecs>;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoProtocol);

      // Install the protocol first
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    describe('configure()', () => {
      it('should configure the protocol on the local DWN', async () => {
        // Already configured in beforeEach — query to verify
        const { status, protocols } = await dwnAlice.protocols.query({
          filter: { protocol: TodoProtocol.definition.protocol },
        });
        expect(status.code).toBe(200);
        expect(protocols).toHaveLength(1);
      });

      it('should skip re-configuration when the definition is unchanged', async () => {
        // Protocol was already configured in beforeEach.
        const { status, protocol } = await typed.configure();

        // Should return 200 (cached) instead of 202 (newly configured).
        expect(status.code).toBe(200);
        expect(protocol).toBeDefined();
        expect(protocol.definition.protocol).toBe(TodoProtocol.definition.protocol);
      });

      it('should re-configure when the definition changes', async () => {
        // Protocol was already configured in beforeEach with the original definition.
        // Create a new TypedEnbox with a modified definition (added a new type).
        const updatedDefinition = {
          ...TodoProtocolDefinition,
          types: {
            ...TodoProtocolDefinition.types,
            tag: {
              schema      : 'https://example.com/schemas/tag',
              dataFormats : ['application/json'] as const,
            },
          },
          structure: {
            ...TodoProtocolDefinition.structure,
            list: {
              ...TodoProtocolDefinition.structure.list,
              task: {
                ...TodoProtocolDefinition.structure.list.task,
              },
            },
          },
        };

        const updatedProtocol = defineProtocol(updatedDefinition, TodoProtocol.codecs);
        const updatedTyped = new TypedEnbox(dwnAlice, updatedProtocol);

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
        expect(record.protocolPath).toBe('list');
        expect(record.schema).toBe('https://example.com/schemas/list');
        expect(record.protocol).toBe('https://example.com/protocols/todo');
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

        expect(taskRecord.protocolPath).toBe('list/task');
        expect(taskRecord.schema).toBe('https://example.com/schemas/task');
      });

      it('should read back written JSON data via Record.value() without manual cast', async () => {
        const inputData = { name: 'Shopping', description: 'Grocery list' };
        const record = await typed.records.create('list', { data: inputData });

        // The protocol payload type is carried by Record<T>.
        const readBack = await record.value();
        expect(readBack.name).toBe('Shopping');
        expect(readBack.description).toBe('Grocery list');
      });

      it('should fail closed with protocol and record context for schema validation failures', async () => {
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
        const validated = new TypedEnbox(dwnAlice, defineProtocol(TodoProtocolDefinition, {
          ...TodoProtocol.codecs,
          list: recordCodecs.json<{ name: string }>({ validator }),
        }));

        await expect(validated.records.create('list', { data: { name: '' } })).rejects.toMatchObject({
          name         : 'RecordValidationError',
          protocolPath : 'list',
          recordId     : undefined,
          schema       : TodoProtocolDefinition.types.list.schema,
        });
        expect((await validated.records.query('list')).records).toHaveLength(0);

        const record = await validated.records.create('list', { data: { name: 'Valid' } });
        const invalidRecord = await validated.records.create('list', { data: { name: 'Invalid' } });
        rejectedName = 'Invalid';

        await expect(record.value()).resolves.toEqual({ name: 'Valid' });
        await expect(invalidRecord.value()).rejects.toMatchObject({
          name         : 'RecordValidationError',
          protocolPath : 'list',
          recordId     : invalidRecord.id,
          schema       : TodoProtocolDefinition.types.list.schema,
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
          protocol  : 'https://example.com/protocols/custom-codec',
          published : true,
          types     : {
            counter: { dataFormats: ['application/x-counter'] },
          },
          structure: { counter: {} },
        } as const satisfies ProtocolDefinition;
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
        const custom = new TypedEnbox(dwnAlice, defineProtocol(definition, { counter: codec }));

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
      // Self-contained protocol with a $squash path, so the shared Todo fixture is untouched.
      const SquashDefinition = {
        protocol  : 'https://example.com/protocols/squash-test',
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
      } as const satisfies ProtocolDefinition;

      const SquashProtocol = defineProtocol(SquashDefinition, {
        doc      : recordCodecs.json<{ n?: string }>(),
        snapshot : recordCodecs.json<{ v?: string }>(),
      });

      let squashed: TypedEnbox<typeof SquashDefinition, typeof SquashProtocol.codecs>;

      beforeEach(async () => {
        squashed = new TypedEnbox(dwnAlice, SquashProtocol);
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
        // Queries on a nested protocol path must be scoped by the parent context
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

    describe('protocol role records', () => {
      const RoleDefinition = {
        protocol  : 'https://example.com/protocols/typed-role-records',
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
      } as const satisfies ProtocolDefinition;
      const RoleProtocol = defineProtocol(RoleDefinition, {
        member    : recordCodecs.json<{ label: string }>(),
        workspace : recordCodecs.json<{ name: string }>(),
      });
      const DeliveryDefinition = {
        ...RoleDefinition,
        protocol : `${RoleDefinition.protocol}/delivery`,
        types    : {
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
      } as const satisfies ProtocolDefinition;
      const DeliveryProtocol = defineProtocol(DeliveryDefinition, {
        ...RoleProtocol.codecs,
        blind  : recordCodecs.json<{ note: string }>(),
        viewer : recordCodecs.json<{ readonly: boolean }>(),
      }, {
        roleGroups: {
          default: ['workspace/member', 'workspace/viewer'],
        },
      });
      type DeliveryRole = 'workspace/member' | 'workspace/viewer';
      type DeliveryMembers = ContextMembersApi<
        typeof DeliveryDefinition,
        typeof DeliveryProtocol.codecs,
        DeliveryRole
      >;
      const recipient = 'did:example:bob';
      const createDeliveryMembers = async (): Promise<DeliveryMembers> => {
        const roleDelivery = {
          get       : sinon.stub().resolves({ state: 'delivered' as const }),
          retry     : sinon.stub().resolves({ state: 'delivered' as const }),
          subscribe : (): (() => void) => (): void => {},
        };
        const roles = new TypedEnbox(dwnAlice, DeliveryProtocol, { roleDelivery });
        await roles.configure();
        const workspace = await roles.records.create('workspace', { data: { name: 'Enbox' } });
        sinon.stub(testHarness.agent.dwn as any, 'provisionAudienceKeyDeliveryForReply').resolves({
          delivered    : false,
          failure      : 'awaiting-recipient-install',
          recipientDid : recipient,
          reason       : 'recipient protocol not installed',
        });
        return (await roles.contexts.open('workspace', workspace.contextId)).members();
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
        const roles = new TypedEnbox(dwnAlice, RoleProtocol);
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
        const roles = new TypedEnbox(dwnAlice, RoleProtocol);
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
            .toContain(DwnErrorCode.ProtocolAuthorizationDuplicateRoleRecipient);
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
        const roles = new TypedEnbox(dwnAlice, DeliveryProtocol, {
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
        const members = owned.members();
        sinon.stub(testHarness.agent.dwn as any, 'provisionAudienceKeyDeliveryForReply').resolves({
          delivered    : false,
          failure      : 'awaiting-recipient-install',
          recipientDid : recipient,
          reason       : 'recipient protocol not installed',
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
            reason : 'recipient protocol not installed',
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

        expect(attachmentRecord.protocolPath).toBe('list/task/attachment');
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
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        const record = await unconfigured.records.create('list', {
          data: { name: 'Auto-configured' },
        });

        expect(record.protocolPath).toBe('list');
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling query() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        const { records } = await unconfigured.records.query('list');

        expect(records).toEqual([]);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling read() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

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
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

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

      it('should install the protocol transparently on first operation', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        // Perform an operation without explicit configure()
        await unconfigured.records.create('list', { data: { name: 'Transparent' } });

        // Verify the protocol was installed
        const { protocols } = await dwnAlice.protocols.query({
          filter: { protocol: TodoProtocol.definition.protocol },
        });
        expect(protocols).toHaveLength(1);
      });
    });

    describe('error paths', () => {
      it('should throw on invalid protocol path', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('invalid protocol path');
      });

      it('should include valid paths in the invalid path error message', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('Valid paths are:');
      });

      it('should throw on invalid nested path', async () => {
        await expect(
          typed.records.query('list/nonexistent' as any),
        ).rejects.toThrow('invalid protocol path');
      });

      it('should report isConfigured as false before configure()', () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);
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

        expect(record.protocolPath).toBe('list');
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

        expect(record.protocolPath).toBe('list');
      });

      it('should normalize nested paths with trailing slashes', async () => {
        const listRecord = await typed.records.create('list', {
          data: { name: 'Nested Slash Test' },
        });

        const record = await typed.records.create('list/task/' as any, {
          data            : { title: 'Slashed Task', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(record.protocolPath).toBe('list/task');
      });
    });

    describe('helper functions (via public API)', () => {
      describe('protocol definition comparison', () => {
        it('should detect equal definitions with different key ordering', async () => {
          // Create a protocol with the same fields but potentially different order.
          // The first configure() stores the definition. A second configure() with an
          // identical definition (same fields, same values) should return 200 (cached).
          const result = await typed.configure();
          expect(result.status.code).toBe(200); // already configured in beforeEach
          expect(result.protocol).toBeDefined();
        });

        it('should detect unequal definitions with added types', async () => {
          // Modify the definition by adding a new type.
          const modifiedDefinition = {
            ...TodoProtocolDefinition,
            types: {
              ...TodoProtocolDefinition.types,
              note: {
                schema      : 'https://example.com/schemas/note',
                dataFormats : ['application/json'] as const,
              },
            },
            structure: {
              ...TodoProtocolDefinition.structure,
            },
          };

          const modifiedProtocol = defineProtocol(modifiedDefinition, TodoProtocol.codecs);
          const modifiedTyped = new TypedEnbox(dwnAlice, modifiedProtocol);

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

          expect(record?.protocolPath).toBe('list');
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
            protocols  : {
              query: sinon.stub().resolves({
                protocols : [{ definition: TodoProtocolDefinition }],
                status    : { code: 200, detail: 'OK' },
              }),
            },
            records: { delete: deleteRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoProtocol);

          await scopedTyped.records.delete('/list/' as any, {
            from         : 'did:example:remote',
            protocolRole : 'list/editor',
            recordId     : 'record-id',
            within       : 'listcontext',
          });

          expect(deleteRecord.calledOnceWithExactly({
            contextId    : 'listcontext',
            from         : 'did:example:remote',
            protocol     : TodoProtocolDefinition.protocol,
            protocolPath : 'list',
            protocolRole : 'list/editor',
            recordId     : 'record-id',
            prune        : undefined,
          })).toBe(true);
        });

        it('should forward within through the canonical read filter', async () => {
          const readRecord = sinon.stub().resolves({ status: { code: 404, detail: 'Not Found' } });
          const dwn = {
            isDelegate : false,
            protocols  : {
              query: sinon.stub().resolves({
                protocols : [{ definition: TodoProtocolDefinition }],
                status    : { code: 200, detail: 'OK' },
              }),
            },
            records: { read: readRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoProtocol);

          const result = await scopedTyped.records.read('/list/' as any, {
            filter       : { recordId: 'record-id' },
            from         : 'did:example:remote',
            protocolRole : 'list/viewer',
            within       : 'listcontext',
          });

          expect(result).toBeUndefined();
          expect(readRecord.calledOnceWithExactly({
            from         : 'did:example:remote',
            protocolRole : 'list/viewer',
            filter       : {
              contextId    : 'listcontext',
              protocol     : TodoProtocolDefinition.protocol,
              protocolPath : 'list',
              recordId     : 'record-id',
              schema       : TodoProtocolDefinition.types.list.schema,
            },
          })).toBe(true);
        });

        it('should reject invalid and retired delete context selectors', async () => {
          const deleteRecord = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
          const dwn = {
            isDelegate : false,
            protocols  : {
              query: sinon.stub().resolves({
                protocols : [{ definition: TodoProtocolDefinition }],
                status    : { code: 200, detail: 'OK' },
              }),
            },
            records: { delete: deleteRecord },
          } as unknown as DwnApi;
          const scopedTyped = new TypedEnbox(dwn, TodoProtocol);

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

      describe('protocol-path type resolution', () => {
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
        it('should recognize all valid paths from the protocol structure', async () => {
          // Verify all expected paths are valid by performing operations on them.
          // If collectPaths is wrong, _assertReady would throw 'invalid protocol path'.
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
          ).rejects.toThrow('invalid protocol path');
        });

        it('should skip $-prefixed keys in the structure', async () => {
          // $actions is a key in the protocol structure but should not be a valid path.
          await expect(
            typed.records.query('list/$actions' as any),
          ).rejects.toThrow('invalid protocol path');
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
        expect(json.protocol).toBe('https://example.com/protocols/todo');
        expect(json.protocolPath).toBe('list');
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
