import type { Persona } from '../utils/test-data-generator.js';
import type { GenericMessageReply, ModuleDefinition } from '../../src/index.js';

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

const coreUri = 'https://example.com/modules/upgrade-core';
const commentsUri = 'https://example.com/modules/upgrade-comments';

function core(): ModuleDefinition {
  return {
    module    : coreUri,
    published : true,
    types     : { workspace: {}, member: {}, note: { schema: 'https://example.com/schemas/note', dataFormats: ['text/plain', 'application/json'] } },
    structure : { workspace: { member: { $role: true }, note: {} } },
  };
}

function comments(): ModuleDefinition {
  return {
    module    : commentsUri,
    published : true,
    uses      : { core: coreUri },
    types     : { comment: { dataFormats: ['text/plain'] } },
    structure : {
      note: {
        $ref    : 'core:workspace/note',
        comment : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read'] }, { who: 'author', of: 'note', can: ['create'] }] },
      },
    },
  };
}

/** Runs against the same injectable Level/SQL backends as ordinary configure admission. */
export function testModuleUpgrades(): void {
  describe('Module imported-contract upgrades', () => {
    let dwn: Dwn;
    let alice: Persona;

    beforeAll(async () => {
      dwn = await Dwn.create({
        ...TestStores.get(),
        eventLog    : TestEventLog.get(),
        didResolver : new UniversalResolver({ didResolvers: [DidKey] }),
      });
    });

    beforeEach(async () => {
      const stores = TestStores.get();
      await stores.messageStore.clear();
      await stores.dataStore.clear();
      await stores.resumableTaskStore.clear();
      alice = await TestDataGenerator.generateDidKeyPersona();
    });

    afterAll(async () => {
      await dwn.close();
    });

    async function configure(definition: ModuleDefinition, day: number): Promise<GenericMessageReply> {
      const { message } = await TestDataGenerator.generateModulesConfigure({
        author           : alice,
        moduleDefinition : definition,
        messageTimestamp : `2025-05-${day.toString().padStart(2, '0')}T00:00:00.000000Z`,
      });
      return dwn.processMessage(alice.did, message);
    }

    async function install(): Promise<void> {
      expect((await configure(core(), 2)).status.code).toBe(202);
      expect((await configure(comments(), 3)).status.code).toBe(202);
    }

    it('accepts unrelated additions and format-set reorderings', async () => {
      await install();
      const definition = core();
      definition.types.extra = {};
      definition.structure.extra = {};
      definition.types.note.dataFormats = ['application/json', 'text/plain'];
      expect((await configure(definition, 4)).status.code).toBe(202);
    });

    it('rejects consumed representation changes even before records exist', async () => {
      await install();
      const definition = core();
      definition.types.note.schema = 'https://example.com/schemas/different-note';
      const reply = await configure(definition, 4);
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureIncompatibleContractUpdate);
      expect(reply.status.detail).toContain(commentsUri);
    });

    it('rejects removal of an imported role or its marker', async () => {
      await install();
      const unmarked = core();
      delete unmarked.structure.workspace.member;
      expect((await configure(unmarked, 4)).status.code).toBe(400);
      unmarked.structure.workspace.member = {};
      expect((await configure(unmarked, 5)).status.code).toBe(400);
    });

    it('allows a provider to remove a role after every consumer detaches its action', async () => {
      await install();
      const detached = comments();
      detached.structure.note.comment = { $actions: [{ who: 'author', of: 'note', can: ['create'] }] };
      expect((await configure(detached, 4)).status.code).toBe(202);
      const definition = core();
      delete definition.structure.workspace.member;
      expect((await configure(definition, 5)).status.code).toBe(202);
    });

    it('does not substitute an older historical configure into current reverse dependents', async () => {
      await install();
      const historical = core();
      delete historical.structure.workspace.member;
      historical.types.note.schema = 'https://example.com/schemas/historical-note';
      expect((await configure(historical, 1)).status.code).toBe(202);
      expect((await configure(comments(), 4)).status.code).toBe(202);
    });

    it('does not activate a late first consumer when its provider has already removed the target', async () => {
      expect((await configure(core(), 2)).status.code).toBe(202);
      const latest = core();
      delete latest.structure.workspace.note;
      expect((await configure(latest, 4)).status.code).toBe(202);
      const reply = await configure(comments(), 3);
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidRefModulePath);
    });

    it('rejects immutable alias and attachment renames', async () => {
      await install();
      const renamedAlias = comments();
      renamedAlias.uses = { renamed: coreUri };
      renamedAlias.structure.note.$ref = 'renamed:workspace/note';
      renamedAlias.structure.note.comment = { $actions: [{ role: 'renamed:workspace/member', can: ['create', 'read'] }] };
      expect((await configure(renamedAlias, 4)).status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidUsesUpdate);

      const renamedNode = comments();
      renamedNode.structure.page = renamedNode.structure.note;
      delete renamedNode.structure.note;
      renamedNode.structure.page.comment = { $actions: [{ role: 'core:workspace/member', can: ['create', 'read'] }] };
      expect((await configure(renamedNode, 5)).status.detail).toContain(DwnErrorCode.ModulesConfigureIncompatibleContractUpdate);
    });

    it('rejects a local-to-reference conversion even when the final owner is a third module', async () => {
      const base = core();
      base.module = 'https://example.com/modules/third-party';
      expect((await configure(base, 1)).status.code).toBe(202);
      await install();
      const redirected = core();
      redirected.uses = { third: base.module };
      redirected.types = { member: {}, note: {} };
      redirected.structure.workspace = {
        $ref   : 'third:workspace',
        member : { $role: true },
        note   : {},
      };
      expect((await configure(redirected, 4)).status.detail).toContain(DwnErrorCode.ModulesConfigureIncompatibleContractUpdate);
    });

    it('preserves retained parent bindings across removal and reintroduction', async () => {
      const provider: ModuleDefinition = {
        module: coreUri, published: true, types: { root: {} }, structure: { root: {} },
      };
      const local: ModuleDefinition = {
        module: commentsUri, published: true, types: { root: {}, child: {} }, structure: { root: { child: {} } },
      };
      expect((await configure(provider, 2)).status.code).toBe(202);
      expect((await configure(local, 3)).status.code).toBe(202);
      const root = await TestDataGenerator.generateRecordsWrite({
        author           : alice, module           : commentsUri, modulePath       : 'root',
        messageTimestamp : '2025-05-03T12:00:00.000000Z', dateCreated      : '2025-05-03T12:00:00.000000Z',
      });
      expect((await dwn.processMessage(alice.did, root.message, { dataStream: root.dataStream })).status.code).toBe(202);
      const child = await TestDataGenerator.generateRecordsWrite({
        author           : alice, module           : commentsUri, modulePath       : 'root/child', parentContextId  : root.message.contextId,
        messageTimestamp : '2025-05-03T12:00:00.000000Z', dateCreated      : '2025-05-03T12:00:00.000000Z',
      });
      expect((await dwn.processMessage(alice.did, child.message, { dataStream: child.dataStream })).status.code).toBe(202);
      expect((await configure({ ...local, types: {}, structure: {} }, 4)).status.code).toBe(202);

      const redirected: ModuleDefinition = {
        ...local,
        uses      : { provider: coreUri },
        types     : { child: {} },
        structure : { root: { $ref: 'provider:root', child: {} } },
      };
      expect((await configure(redirected, 5)).status.detail).toContain(DwnErrorCode.ModulesConfigureIncompatibleContractUpdate);
      const retained = await TestStores.get().messageStore.query(alice.did, [{ module: commentsUri, interface: 'Records', method: 'Write' }]);
      expect(retained.messages).toHaveLength(2);
    });

    it('rejects squashable imported ancestry and preserves independent versioned URIs', async () => {
      await install();
      const squashable = core();
      squashable.structure.workspace.$squash = true;
      expect((await configure(squashable, 4)).status.code).toBe(400);
      const independent = core();
      independent.module = `${coreUri}/v2`;
      independent.types.note.schema = 'https://example.com/schemas/v2-note';
      expect((await configure(independent, 5)).status.code).toBe(202);
    });
  });
}
