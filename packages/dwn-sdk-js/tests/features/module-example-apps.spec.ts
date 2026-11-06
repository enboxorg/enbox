import type { Persona } from '../utils/test-data-generator.js';
import type { ModuleDefinition, ModulesConfigureMessage } from '../../src/types/modules-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';
import type { RecordsReadReply, RecordsWriteMessage } from '../../src/types/records-types.js';
import type { SourceRoleAudienceKeyEncryption, X25519KeyEncryptionInput } from '../../src/utils/encryption.js';

import chatExtras from '../vectors/module-composition/team-chat/message-extras.json' with { type: 'json' };
import chatMessages from '../vectors/module-composition/team-chat/messages.json' with { type: 'json' };
import chatTeam from '../vectors/module-composition/team-chat/team.json' with { type: 'json' };
import eventAgenda from '../vectors/module-composition/event-planner/event-agenda.json' with { type: 'json' };
import eventComments from '../vectors/module-composition/event-planner/session-comments.json' with { type: 'json' };
import eventCore from '../vectors/module-composition/event-planner/event-core.json' with { type: 'json' };
import eventPlanning from '../vectors/module-composition/event-planner/event-planning.json' with { type: 'json' };
import notesCore from '../vectors/module-composition/notes/core.json' with { type: 'json' };
import notesDiscussion from '../vectors/module-composition/notes/discussion.json' with { type: 'json' };
import notesFiles from '../vectors/module-composition/notes/files.json' with { type: 'json' };
import projectActivity from '../vectors/module-composition/project-board/activity.json' with { type: 'json' };
import projectBoards from '../vectors/module-composition/project-board/boards.json' with { type: 'json' };
import projectWorkspace from '../vectors/module-composition/project-board/workspace.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from '../../src/core/constants.js';
import { getRoleAudienceContextId } from '../../src/core/module-role-records.js';
import { Jws } from '../../src/utils/jws.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { Message } from '../../src/core/message.js';
import { Modules } from '../../src/utils/modules.js';
import { ModulesConfigure } from '../../src/interfaces/modules-configure.js';
import { RecordsCount } from '../../src/interfaces/records-count.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { resolveModuleGraph } from '../../src/core/module-graph.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { X25519 } from '@enbox/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../../src/utils/encryption.js';

type Step = {
  id: string;
  module: string;
  path: string;
  parent?: string;
  actor?: 'bob';
  role?: string;
  recipient?: 'bob' | 'carol';
  data?: unknown;
};

type App = {
  name: string;
  definitions: ModuleDefinition[];
  steps: Step[];
  readRole: string;
};

type Audience = { privateKey: PrivateKeyJwk; publicKey: PublicKeyJwk; keyId: string };

const apps: App[] = [
  {
    name        : 'Notes',
    definitions : [notesCore, notesFiles, notesDiscussion],
    readRole    : 'core:notebook/viewer',
    steps       : [
      { id: 'root', module: notesCore.module, path: 'notebook', data: { name: 'Research' } },
      { id: 'writer', module: notesCore.module, path: 'notebook/editor', parent: 'root', recipient: 'bob' },
      { id: 'reader', module: notesCore.module, path: 'notebook/viewer', parent: 'root', recipient: 'carol' },
      { id: 'note', module: notesCore.module, path: 'notebook/note', parent: 'root', data: { title: 'Composition' } },
      { id: 'text', module: notesCore.module, path: 'notebook/note/text', parent: 'note', actor: 'bob', role: 'notebook/editor', data: 'Native text' },
      { id: 'file', module: notesFiles.module, path: 'note/file', parent: 'note', actor: 'bob', role: 'core:notebook/editor', data: new Uint8Array([1, 2, 3]) },
      { id: 'comment', module: notesDiscussion.module, path: 'note/comment', parent: 'note', actor: 'bob', role: 'core:notebook/editor', data: { text: 'Example' } },
      { id: 'last', module: notesDiscussion.module, path: 'note/comment/reaction', parent: 'comment', actor: 'bob', role: 'core:notebook/editor', data: { emoji: 'yes' } },
    ],
  },
  {
    name        : 'Project Board',
    definitions : [projectWorkspace, projectBoards, projectActivity],
    readRole    : 'workspace:workspace/viewer',
    steps       : [
      { id: 'root', module: projectWorkspace.module, path: 'workspace', data: { name: 'Team' } },
      { id: 'writer', module: projectWorkspace.module, path: 'workspace/manager', parent: 'root', recipient: 'bob' },
      { id: 'reader', module: projectWorkspace.module, path: 'workspace/viewer', parent: 'root', recipient: 'carol' },
      { id: 'board', module: projectBoards.module, path: 'workspace/board', parent: 'root', actor: 'bob', role: 'workspace:workspace/manager', data: { name: 'Work' } },
      { id: 'task', module: projectBoards.module, path: 'workspace/board/task', parent: 'board', actor: 'bob', role: 'workspace:workspace/manager', data: { title: 'Ship' } },
      { id: 'last', module: projectActivity.module, path: 'task/comment', parent: 'task', actor: 'bob', role: 'workspace:workspace/manager', data: { text: 'Done' } },
    ],
  },
  {
    name        : 'Team Chat',
    definitions : [chatTeam, chatMessages, chatExtras],
    readRole    : 'team:team/member',
    steps       : [
      { id: 'root', module: chatTeam.module, path: 'team', data: { name: 'Team' } },
      { id: 'writer', module: chatTeam.module, path: 'team/moderator', parent: 'root', recipient: 'bob' },
      { id: 'reader', module: chatTeam.module, path: 'team/member', parent: 'root', recipient: 'carol' },
      { id: 'channel', module: chatTeam.module, path: 'team/channel', parent: 'root', actor: 'bob', role: 'team/moderator', data: { name: 'Chat' } },
      { id: 'message', module: chatMessages.module, path: 'channel/message', parent: 'channel', actor: 'bob', role: 'team:team/moderator', data: { text: 'Hello' } },
      { id: 'last', module: chatExtras.module, path: 'message/reaction', parent: 'message', actor: 'bob', role: 'team:team/moderator', data: { emoji: 'yes' } },
    ],
  },
  {
    name        : 'Event Planner',
    definitions : [eventCore, eventPlanning, eventAgenda, eventComments],
    readRole    : 'events:event/attendee',
    steps       : [
      { id: 'root', module: eventCore.module, path: 'event', data: { name: 'Conference' } },
      { id: 'writer', module: eventCore.module, path: 'event/organizer', parent: 'root', recipient: 'bob' },
      { id: 'reader', module: eventCore.module, path: 'event/attendee', parent: 'root', recipient: 'carol' },
      { id: 'plan', module: eventPlanning.module, path: 'event/plan', parent: 'root', actor: 'bob', role: 'events:event/organizer', data: { text: 'Prepare' } },
      { id: 'session', module: eventAgenda.module, path: 'event/session', parent: 'root', actor: 'bob', role: 'events:event/organizer', data: { title: 'DWN' } },
      { id: 'last', module: eventComments.module, path: 'session/comment', parent: 'session', actor: 'bob', role: 'events:event/organizer', data: { text: 'Question' } },
    ],
  },
];

/** Exercises the actual authored examples through signed DWN messages and real encryption. */
export function testModuleExampleApps(): void {
  describe('composed example applications', () => {
    const stores = TestStores.get();
    let dwn: Dwn;
    let alice: Persona;
    let bob: Persona;
    let carol: Persona;
    const installed = new Map<string, ModuleDefinition>();
    const configurations = new Map<string, ModulesConfigureMessage>();
    const audiences = new Map<string, Audience>();

    beforeAll(async () => {
      dwn = await Dwn.create({ ...stores, eventLog: TestEventLog.get() });
    });
    beforeEach(async () => {
      await stores.messageStore.clear();
      await stores.dataStore.clear();
      await stores.resumableTaskStore.clear();
      [alice, bob, carol] = await Promise.all([
        TestDataGenerator.generateDidKeyPersona(), TestDataGenerator.generateDidKeyPersona(), TestDataGenerator.generateDidKeyPersona(),
      ]);
      installed.clear();
      configurations.clear();
      audiences.clear();
    });
    afterAll(async () => { await dwn.close(); });

    async function install(authored: ModuleDefinition): Promise<void> {
      const definition = await Modules.deriveAndInjectPublicEncryptionKeys(authored,
        TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
      const configure = await ModulesConfigure.create({ definition, signer: Jws.createSigner(alice) });
      const reply = await dwn.processMessage(alice.did, configure.message);
      expect(reply.status.code, reply.status.detail).toBe(202);
      installed.set(definition.module, definition);
      configurations.set(definition.module, configure.message);
    }

    async function audience(module: string, rolePath: string, contextId: string): Promise<Audience> {
      const cacheKey = JSON.stringify([module, rolePath, contextId]);
      const previous = audiences.get(cacheKey);
      if (previous !== undefined) {
        return previous;
      }
      const graph = resolveModuleGraph(installed.get(module)!, uri => installed.get(uri));
      const role = graph.resolveInvokedRole(rolePath);
      const sealPublicKey = role.ruleSet.$keyAgreement!.publicKeyJwk;
      const privateKey = await X25519.generateKey() as PrivateKeyJwk;
      const publicKey = await X25519.getPublicKey({ key: privateKey }) as PublicKeyJwk;
      const keyId = await Encryption.getKeyId(publicKey);
      const sealedPrivateKey = await Encryption.wrapSeal({
        privateKeyBytes : await X25519.privateKeyToBytes({ privateKey }),
        keyInput        : {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : 'seal',
          module,
          rolePath,
          contextId,
          audienceKeyId    : keyId,
          keyId            : await Encryption.getKeyId(sealPublicKey),
          publicKey        : sealPublicKey,
        },
      });
      const data = Encoder.objectToBytes({ module, rolePath, contextId, keyId, publicKeyJwk: publicKey, sealedPrivateKey });
      const write = await RecordsWrite.create({
        signer     : Jws.createSigner(alice),
        module,
        modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        schema     : 'https://identity.foundation/dwn/json-schemas/encryption/audience.json',
        dataFormat : 'application/json',
        data,
        tags       : { module, rolePath, contextId, keyId },
      });
      const reply = await dwn.processMessage(alice.did, write.message, { dataStream: DataStream.fromBytes(data) });
      expect(reply.status.code, reply.status.detail).toBe(202);
      const material = { privateKey, publicKey, keyId };
      audiences.set(cacheKey, material);
      return material;
    }

    async function prepare(
      step: Step,
      parentContextId?: string,
      omittedRoute?: 'path' | 'audience',
    ): Promise<{ write: RecordsWrite; data: Uint8Array; plaintext: Uint8Array }> {
      const graph = resolveModuleGraph(installed.get(step.module)!, uri => installed.get(uri));
      const node = graph.nodesByDeclaredPath.get(step.path)!;
      const plaintext = step.data instanceof Uint8Array ? step.data
        : typeof step.data === 'string' ? Encoder.stringToBytes(step.data) : Encoder.objectToBytes(step.data ?? {});
      const signer = Jws.createSigner(step.actor === 'bob' ? bob : alice);
      const dateCreated = Time.getCurrentTimestamp();
      const options = {
        signer,
        module           : step.module,
        modulePath       : step.path,
        moduleRole       : step.role,
        parentContextId,
        recipient        : step.recipient === 'bob' ? bob.did : step.recipient === 'carol' ? carol.did : undefined,
        schema           : node.recordType.schema,
        dataFormat       : node.recordType.dataFormats![0],
        dateCreated,
        messageTimestamp : dateCreated,
      };
      if (node.recordType.encryptionRequired !== true) {
        return { write: await RecordsWrite.create({ ...options, data: plaintext }), data: plaintext, plaintext };
      }
      const key = TestDataGenerator.randomBytes(32);
      const initializationVector = TestDataGenerator.randomBytes(16);
      const data = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, initializationVector, plaintext);
      const pathPublicKey = node.ruleSet.$keyAgreement!.publicKeyJwk;
      const keyEncryptionInputs: X25519KeyEncryptionInput[] = [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : KeyDerivationScheme.ModulePath,
        keyId            : await Encryption.getKeyId(pathPublicKey),
        publicKey        : pathPublicKey,
      }];
      const encryptionInput = { key, initializationVector, keyEncryptionInputs };
      const provisional = await RecordsWrite.create({ ...options, data, encryptionInput });
      for (const action of node.actions) {
        if (omittedRoute === 'audience' || action.resolvedRole === undefined || !action.rule.can.includes('read')) {
          continue;
        }
        const role = action.resolvedRole;
        const material = await audience(role.owningModuleUri, role.owningModulePath,
          getRoleAudienceContextId(role, provisional.message.contextId)!);
        keyEncryptionInputs.push({
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          module           : role.owningModuleUri,
          rolePath         : role.owningModulePath,
          keyId            : material.keyId,
          publicKey        : material.publicKey,
        });
      }
      if (omittedRoute === 'path') {
        keyEncryptionInputs.shift();
      }
      const write = await RecordsWrite.create({ ...options, data, encryptionInput });
      expect(write.message.recordId).toBe(provisional.message.recordId);
      return { write, data, plaintext };
    }

    for (const app of apps) {
      it(`${app.name}: installs the full example and reads encrypted nested extensions through shared roles`, async () => {
        for (const definition of app.definitions) {
          await install(definition);
        }
        const records = new Map<string, RecordsWriteMessage>();
        let expectedData: Uint8Array = new Uint8Array();
        for (const step of app.steps) {
          const parent = step.parent === undefined ? undefined : records.get(step.parent)!.contextId;
          const { write, data, plaintext } = await prepare(step, parent);
          const reply = await dwn.processMessage(alice.did, write.message, { dataStream: DataStream.fromBytes(data) });
          expect(reply.status.code, `${step.id}: ${reply.status.detail}`).toBe(202);
          records.set(step.id, write.message);
          expectedData = plaintext;
        }
        const lastStep = app.steps.at(-1)!;
        const last = records.get('last')!;
        const parent = records.get(lastStep.parent!)!;
        expect(last.contextId).toBe(`${parent.contextId}/${last.recordId}`);
        const read = await RecordsRead.create({ signer                    : Jws.createSigner(carol), moduleRole                : app.readRole,
          includeReplicationSupport : true, filter                    : { recordId: last.recordId } });
        const readReply = await dwn.processMessage(alice.did, read.message) as RecordsReadReply;
        expect(readReply.status.code, readReply.status.detail).toBe(200);
        const graph = resolveModuleGraph(installed.get(lastStep.module)!, uri => installed.get(uri));
        const support = readReply.support!;
        const configSupport = support.filter(entry => entry.message.descriptor.interface === 'Modules');
        expect(new Set(configSupport.map(entry => (entry.message as ModulesConfigureMessage).descriptor.definition.module)))
          .toEqual(new Set(graph.definitionsByUri.keys()));
        for (const entry of configSupport) {
          const configure = entry.message as ModulesConfigureMessage;
          expect(await Message.getCid(configure)).toBe(await Message.getCid(configurations.get(configure.descriptor.definition.module)!));
        }
        const node = graph.nodesByDeclaredPath.get(lastStep.path)!;
        const physicalIds = last.contextId.split('/');
        for (const [index, ancestor] of node.physicalAncestors.entries()) {
          const entry = support.find(item => (item.message as RecordsWriteMessage).recordId === physicalIds[index])!;
          const message = entry.message as RecordsWriteMessage;
          expect(message.descriptor.module).toBe(ancestor.owningModuleUri);
          expect(message.descriptor.modulePath).toBe(ancestor.owningModulePath);
          const original = [...records.values()].find(record => record.recordId === message.recordId)!;
          expect(await Message.getCid(message)).toBe(await Message.getCid(original));
          expect(message.authorization).toEqual(original.authorization);
          expect(entry.encodedData).toBeUndefined();
        }
        expect(readReply.entry!.data).toBeUndefined();
        const payloadRead = await RecordsRead.create({ signer     : Jws.createSigner(carol), moduleRole : app.readRole,
          filter     : { recordId: last.recordId } });
        const payloadReply = await dwn.processMessage(alice.did, payloadRead.message) as RecordsReadReply;
        expect(payloadReply.status.code, payloadReply.status.detail).toBe(200);
        const role = graph.resolveInvokedRole(app.readRole);
        const material = audiences.get(JSON.stringify([role.owningModuleUri, role.owningModulePath,
          getRoleAudienceContextId(role, last.contextId)]))!;
        const encrypted = readReply.entry!.recordsWrite!.encryption!;
        const entry = encrypted.keyEncryption.find(candidate => candidate.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
          candidate.module === role.owningModuleUri && candidate.rolePath === role.owningModulePath) as SourceRoleAudienceKeyEncryption;
        const key = await Encryption.unwrapKey(material.privateKey, entry);
        const plaintext = await Encryption.decrypt(encrypted.algorithm, key, Encoder.base64UrlToBytes(encrypted.initializationVector),
          await DataStream.toBytes(payloadReply.entry!.data!));
        expect(plaintext).toEqual(expectedData);

        const filter = { module: lastStep.module, modulePath: lastStep.path, contextId: parent.contextId };
        const query = await RecordsQuery.create({ signer: Jws.createSigner(carol), moduleRole: app.readRole, filter });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code, queryReply.status.detail).toBe(200);
        expect(queryReply.entries?.map(entry => entry.recordId)).toEqual([last.recordId]);
        const count = await RecordsCount.create({ signer: Jws.createSigner(carol), moduleRole: app.readRole, filter });
        expect((await dwn.processMessage(alice.did, count.message)).count).toBe(1);

        const outsider = await TestDataGenerator.generateDidKeyPersona();
        const denied = await RecordsRead.create({
          signer: Jws.createSigner(outsider), moduleRole: app.readRole, filter: { recordId: last.recordId },
        });
        expect((await dwn.processMessage(alice.did, denied.message)).status.code).toBe(401);
        const wrongParent = await prepare(lastStep, records.get('root')!.contextId);
        const wrongParentReply = await dwn.processMessage(alice.did, wrongParent.write.message,
          { dataStream: DataStream.fromBytes(wrongParent.data) });
        expect(wrongParentReply.status.code).toBe(400);

        for (const omittedRoute of ['path', 'audience'] as const) {
          const invalid = await prepare({ ...lastStep, actor: undefined, role: undefined }, parent.contextId, omittedRoute);
          const invalidReply = await dwn.processMessage(alice.did, invalid.write.message, { dataStream: DataStream.fromBytes(invalid.data) });
          expect(invalidReply.status.code).toBe(400);
          expect(invalidReply.status.detail).toContain(omittedRoute === 'path'
            ? DwnErrorCode.ModuleAuthorizationEncryptionModulePathEntryMissing
            : DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceEntryMissing);
        }

        const refPath = [...graph.nodesByDeclaredPath].find(([, node]) => node.kind === 'ref')![0];
        const shadow = await RecordsWrite.create({ signer     : Jws.createSigner(alice), module     : lastStep.module, modulePath : refPath,
          dataFormat : 'application/json', data       : Encoder.objectToBytes({}) });
        const shadowReply = await dwn.processMessage(alice.did, shadow.message, { dataStream: DataStream.fromBytes(Encoder.objectToBytes({})) });
        expect(shadowReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationRefNodeWriteNotAllowed);
      });
    }

    it('scopes a local role under a deep attachment to one physical board', async () => {
      const base: ModuleDefinition = { module    : 'https://example.com/board-base', published : false,
        types     : { workspace: { dataFormats: ['application/json'] }, board: { dataFormats: ['application/json'] } },
        structure : { workspace: { board: {} } } };
      const extension: ModuleDefinition = { module    : 'https://example.com/board-extension', published : false,
        uses      : { base: base.module }, types     : { moderator: { dataFormats: ['application/json'] }, note: { dataFormats: ['application/json'] } },
        structure : { board: { $ref      : 'base:workspace/board', moderator : { $role: true },
          note      : { $actions: [{ role: 'board/moderator', can: ['create', 'read'] }] } } } };
      await install(base);
      await install(extension);
      const root = await prepare({ id: 'root', module: base.module, path: 'workspace' });
      expect((await dwn.processMessage(alice.did, root.write.message, { dataStream: DataStream.fromBytes(root.data) })).status.code).toBe(202);
      const boards: RecordsWriteMessage[] = [];
      for (let index = 0; index < 2; index++) {
        const board = await prepare({ id: 'board', module: base.module, path: 'workspace/board', data: { index } }, root.write.message.contextId);
        expect((await dwn.processMessage(alice.did, board.write.message, { dataStream: DataStream.fromBytes(board.data) })).status.code).toBe(202);
        boards.push(board.write.message);
      }
      const assignment = await prepare({ id: 'role', module: extension.module, path: 'board/moderator', recipient: 'bob' }, boards[0].contextId);
      const assignmentReply = await dwn.processMessage(alice.did, assignment.write.message,
        { dataStream: DataStream.fromBytes(assignment.data) });
      expect(assignmentReply.status.code).toBe(202);
      for (let index = 0; index < 2; index++) {
        const note = await prepare({ id: 'note', module: extension.module, path: 'board/note', actor: 'bob', role: 'board/moderator' }, boards[index].contextId);
        const noteReply = await dwn.processMessage(alice.did, note.write.message, { dataStream: DataStream.fromBytes(note.data) });
        expect(noteReply.status.code).toBe(index === 0 ? 202 : 401);
      }
    });
  });
}
