import type { EnboxTestContext } from '@enbox/api/testing';
import type { ModuleCatalogEntry } from '../src/catalog-types.js';
import type { Record as DwnRecord, TypedModule } from '@enbox/api';

import { BelongingsModule } from '../src/belongings.js';
import { createEnboxTestContext } from '@enbox/api/testing';
import { defineApplicationManifest } from '@enbox/api';
import { DidJwk } from '@enbox/dids';
import { FilesModule } from '../src/files.js';
import { GroceriesModule } from '../src/groceries.js';
import { IdentityDocumentsModule } from '../src/identity-documents.js';
import { WarrantiesModule } from '../src/warranties.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnMethodName, Encoder, RecordsDelete, RecordsRead, RecordsWrite } from '@enbox/dwn-sdk-js';
import { exampleValue, expectExample } from './utils/record-examples.js';
import { moduleCatalog, standardModules } from '../src/catalog.js';

const modulesByUri = new Map(standardModules.map((module): [string, TypedModule] => [module.definition.module, module]));
const entriesByUri = new Map(moduleCatalog.map((entry): [string, ModuleCatalogEntry] => [entry.uri, entry]));

describe('standard modules on a real DWN', () => {
  let context: EnboxTestContext;
  const created = new Map<string, DwnRecord<unknown>>();

  beforeAll(async () => {
    context = await createEnboxTestContext({ application: defineApplicationManifest({ modules: [...standardModules] }) });
  }, 120_000);

  afterAll(async () => {
    await context.close();
  });

  async function ensureRecord(uri: string, path: string): Promise<DwnRecord<unknown>> {
    const key = `${uri}#${path}`;
    const existing = created.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const module = modulesByUri.get(uri)!;
    const api = context.enbox.using(module);
    const node = api.graph.nodesByDeclaredPath.get(path)!;
    if (node.kind !== 'record') {
      throw new Error(`Test attempted to write a virtual attachment: ${key}`);
    }
    const parent =
      node.expectedParent === undefined
        ? undefined
        : await ensureRecord(node.expectedParent.owningModuleUri, node.expectedParent.owningModulePath);
    const example = entriesByUri.get(uri)!.examples.find((value): boolean => value.path === path)!;
    const record = await api.records.create(path, {
      data            : exampleValue(example),
      parentContextId : parent?.contextId,
      tags            : example.tags,
    });
    created.set(key, record);
    return record;
  }

  for (const entry of moduleCatalog) {
    it(`installs and round-trips every ${entry.name} data path with its declared encryption policy`, async () => {
      const api = context.enbox.using(modulesByUri.get(entry.uri)!);
      expect((await api.verifyInstalled()).status).toBe('up-to-date');
      for (const contract of entry.records.filter((record): boolean => !record.role)) {
        const record = await ensureRecord(entry.uri, contract.path);
        const message = record.rawMessage;
        expect(message.descriptor.method).toBe(DwnMethodName.Write);
        expect('encryption' in message && message.encryption !== undefined).toBe(contract.encryptionRequired);
        const loaded = await api.records.read(contract.path, record.id);
        expect(loaded).toBeDefined();
        const example = entry.examples.find((example): boolean => example.path === contract.path)!;
        await expectExample(await loaded!.value(), exampleValue(example), example);
      }
    }, 30_000);
  }

  it('denies unrelated signers access to each private record path', async () => {
    const outsider = await DidJwk.create();
    const signer = await outsider.getSigner();
    for (const entry of moduleCatalog) {
      if (entry.id === 'profile' || entry.id === 'connect') {
        continue;
      }
      for (const contract of entry.records.filter((record): boolean => !record.role)) {
        const record = await ensureRecord(entry.uri, contract.path);
        const read = await RecordsRead.create({
          filter : { recordId: record.id },
          signer : {
            algorithm : signer.algorithm,
            keyId     : signer.keyId,
            sign      : (data: Uint8Array): Promise<Uint8Array> => signer.sign({ data }),
          },
        });
        const reply = await context.enbox.agent.dwn.node.processMessage(context.enbox.connectedDid, read.message);
        expect(reply.status.code, `${entry.id}/${contract.path}`).toBe(401);
      }
    }
  }, 30_000);

  it('scopes every membership leave to its recipient and every viewer to read-only access', async () => {
    const owner = (await context.enbox.agent.did.get({ didUri: context.enbox.connectedDid }))!;
    const ownerSigner = await owner.getSigner();
    const first = await DidJwk.create();
    const second = await DidJwk.create();
    const firstSigner = await first.getSigner();
    const ownerSignature = {
      algorithm : ownerSigner.algorithm,
      keyId     : ownerSigner.keyId,
      sign      : (data: Uint8Array): Promise<Uint8Array> => ownerSigner.sign({ data }),
    };
    const firstSignature = {
      algorithm : firstSigner.algorithm,
      keyId     : firstSigner.keyId,
      sign      : (data: Uint8Array): Promise<Uint8Array> => firstSigner.sign({ data }),
    };
    const dwn = context.enbox.agent.dwn.node;
    for (const entry of moduleCatalog) {
      for (const membership of entry.records.filter((record): boolean => record.role)) {
        const node = context.enbox.using(modulesByUri.get(entry.uri)!).graph.nodesByDeclaredPath.get(membership.path)!;
        const parent = await ensureRecord(node.expectedParent!.owningModuleUri, node.expectedParent!.owningModulePath);
        const assignments = [];
        for (const recipient of [first.uri, second.uri]) {
          const data = Encoder.objectToBytes({});
          const assignment = await RecordsWrite.create({
            module          : entry.uri,
            modulePath      : membership.path,
            schema          : membership.schemaUri,
            parentContextId : parent.contextId,
            recipient,
            dataFormat      : 'application/json',
            data,
            signer          : ownerSignature,
          });
          const reply = await dwn.processMessage(owner.uri, assignment.message, { dataStream: DataStream.fromBytes(data) });
          expect(reply.status.code, `${entry.id}/${membership.path}: ${reply.status.detail}`).toBe(202);
          assignments.push(assignment.message);
        }
        for (const moduleRole of [undefined, membership.path]) {
          const request = await RecordsDelete.create({ recordId: assignments[1].recordId, signer: firstSignature, moduleRole });
          expect((await dwn.processMessage(owner.uri, request.message)).status.code, `${entry.id}/${membership.path}`).toBe(401);
        }
        if (membership.type === 'viewer') {
          for (const consumer of moduleCatalog) {
            for (const contract of consumer.records) {
              const action = contract.actions.find((rule): boolean => {
                if (rule.role === undefined) {
                  return false;
                }
                const [alias, path] = rule.role.includes(':') ? rule.role.split(':') : [undefined, rule.role];
                return path === membership.path && (alias === undefined ? consumer.uri : consumer.dependencies[alias]) === entry.uri;
              });
              if (action === undefined) {
                continue;
              }
              const target = contract.role
                ? undefined // Notebook writer rosters are covered by the notebook integration test.
                : await ensureRecord(consumer.uri, contract.path);
              if (target === undefined) {
                continue;
              }
              const read = await RecordsRead.create({ filter: { recordId: target.id }, signer: firstSignature, moduleRole: action.role });
              expect((await dwn.processMessage(owner.uri, read.message)).status.code, `${consumer.id}/${contract.path}`).toBe(200);
              for (const prune of [false, true]) {
                const remove = await RecordsDelete.create({ recordId: target.id, signer: firstSignature, moduleRole: action.role, prune });
                expect((await dwn.processMessage(owner.uri, remove.message)).status.code, `${consumer.id}/${contract.path}`).toBe(401);
              }
            }
          }
        }
        const leave = await RecordsDelete.create({ recordId: assignments[0].recordId, signer: firstSignature });
        expect((await dwn.processMessage(owner.uri, leave.message)).status.code, `${entry.id}/${membership.path}`).toBe(202);
        const revoke = await RecordsDelete.create({ recordId: assignments[1].recordId, signer: ownerSignature });
        expect((await dwn.processMessage(owner.uri, revoke.message)).status.code).toBe(202);
      }
    }
  }, 30_000);

  it('keeps a foreign viewer role scoped to its real owning item and denies its writes', async () => {
    const owner = (await context.enbox.agent.did.get({ didUri: context.enbox.connectedDid }))!;
    const ownerSigner = await owner.getSigner();
    const viewer = await DidJwk.create();
    const viewerSigner = await viewer.getSigner();
    const item = await context.enbox.using(BelongingsModule).records.create('item', { data: { name: 'Shared appliance', state: 'owned' } });
    const sibling = await context.enbox
      .using(BelongingsModule)
      .records.create('item', { data: { name: 'Private appliance', state: 'owned' } });
    const warranty = await context.enbox
      .using(WarrantiesModule)
      .records.create('item/warranty', { parentContextId: item.contextId, data: { provider: 'Example' } });
    const otherWarranty = await context.enbox
      .using(WarrantiesModule)
      .records.create('item/warranty', { parentContextId: sibling.contextId, data: { provider: 'Other' } });
    const data = Encoder.objectToBytes({});
    const role = await RecordsWrite.create({
      module          : BelongingsModule.definition.module,
      modulePath      : 'item/viewer',
      parentContextId : item.contextId,
      recipient       : viewer.uri,
      schema          : BelongingsModule.definition.types.viewer.schema,
      dataFormat      : 'application/json',
      data,
      signer          : {
        algorithm : ownerSigner.algorithm,
        keyId     : ownerSigner.keyId,
        sign      : (bytes: Uint8Array): Promise<Uint8Array> => ownerSigner.sign({ data: bytes }),
      },
    });
    const roleReply = await context.enbox.agent.dwn.node.processMessage(context.enbox.connectedDid, role.message, {
      dataStream: DataStream.fromBytes(data),
    });
    expect(roleReply.status.code).toBe(202);
    for (const [target, expected] of [
      [warranty, 200],
      [otherWarranty, 401],
    ] as const) {
      const query = await RecordsRead.create({
        filter     : { recordId: target.id },
        moduleRole : 'belongings:item/viewer',
        signer     : {
          algorithm : viewerSigner.algorithm,
          keyId     : viewerSigner.keyId,
          sign      : (bytes: Uint8Array): Promise<Uint8Array> => viewerSigner.sign({ data: bytes }),
        },
      });
      const reply = await context.enbox.agent.dwn.node.processMessage(context.enbox.connectedDid, query.message);
      expect(reply.status.code).toBe(expected);
    }
    const attempt = await RecordsDelete.create({
      recordId   : warranty.id,
      moduleRole : 'belongings:item/viewer',
      signer     : {
        algorithm : viewerSigner.algorithm,
        keyId     : viewerSigner.keyId,
        sign      : (bytes: Uint8Array): Promise<Uint8Array> => viewerSigner.sign({ data: bytes }),
      },
    });
    const reply = await context.enbox.agent.dwn.node.processMessage(context.enbox.connectedDid, attempt.message);
    expect(reply.status.code).toBe(401);
  }, 30_000);

  it('updates a mutable grocery item and rejects mutation of immutable history', async () => {
    const list = await context.enbox.using(GroceriesModule).records.create('list', { data: { name: 'Shopping' } });
    const item = await context.enbox.using(GroceriesModule).records.create('list/item', {
      parentContextId : list.contextId,
      data            : { name: 'Milk', state: 'needed' },
    });
    await item.update({ data: { name: 'Milk', state: 'purchased' } });
    expect((await item.value()).state).toBe('purchased');
    const entry = getEntry('pantry');
    const change = await ensureRecord(entry.uri, 'pantry/item/change');
    await expect(
      change.update({ data: { kind: 'used', quantity: { value: '2', unit: 'can' }, occurredAt: '2026-01-15T12:00:00Z' } }),
    ).rejects.toThrow();
  });

  it('requires encryption even for an owner writing through the raw DWN API', async () => {
    const owner = (await context.enbox.agent.did.get({ didUri: context.enbox.connectedDid }))!;
    const signer = await owner.getSigner();
    const data = Encoder.objectToBytes({ name: 'Unencrypted list' });
    const write = await RecordsWrite.create({
      module     : GroceriesModule.definition.module,
      modulePath : 'list',
      schema     : GroceriesModule.definition.types.list.schema,
      dataFormat : 'application/json',
      data,
      signer     : {
        algorithm : signer.algorithm,
        keyId     : signer.keyId,
        sign      : (bytes: Uint8Array): Promise<Uint8Array> => signer.sign({ data: bytes }),
      },
    });
    const reply = await context.enbox.agent.dwn.node.processMessage(context.enbox.connectedDid, write.message, {
      dataStream: DataStream.fromBytes(data),
    });
    expect(reply.status.code).toBe(400);
    expect(reply.status.detail.toLowerCase()).toContain('encryption');
  });

  it('prunes real extension children while preserving independently linked scans', async () => {
    const item = await context.enbox
      .using(BelongingsModule)
      .records.create('item', { data: { name: 'Disposable test item', state: 'owned' } });
    const warranty = await context.enbox
      .using(WarrantiesModule)
      .records.create('item/warranty', { parentContextId: item.contextId, data: { provider: 'Example' } });
    await item.delete({ prune: true });
    expect(await context.enbox.using(WarrantiesModule).records.read('item/warranty', warranty.id)).toBeUndefined();

    const file = await context.enbox.using(FilesModule).records.create('file', { data: { name: 'scan.txt', mediaType: 'text/plain' } });
    const document = await context.enbox.using(IdentityDocumentsModule).records.create('document', {
      data: { label: 'Test document', documentType: 'other', reviewState: 'unreviewed', sources: [{ recordId: file.id }] },
    });
    await document.delete({ prune: true });
    expect(await context.enbox.using(FilesModule).records.read('file', file.id)).toBeDefined();
  });
});

function getEntry(id: string): ModuleCatalogEntry {
  return moduleCatalog.find((entry): boolean => entry.id === id)!;
}
