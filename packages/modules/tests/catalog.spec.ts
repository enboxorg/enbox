import type { ModuleCatalogEntry } from '../src/catalog-types.js';
import type { RecordCodec, TypedModule } from '@enbox/api';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';
import { RecordValidationError } from '@enbox/api';
import { resolveTypedModuleGraph } from '@enbox/api/advanced';
import { describe, expect, it } from 'bun:test';
import { exampleValue, expectExample, recordData } from './utils/record-examples.js';
import { getModuleCatalogEntry, moduleCatalog, searchModuleCatalog, standardModules } from '../src/catalog.js';
import { readdir, readFile } from 'node:fs/promises';

const modulesByUri = new Map(standardModules.map((module): [string, TypedModule] => [module.definition.module, module]));
type CodecMap = globalThis.Record<string, RecordCodec<unknown>>;

function moduleFor(entry: ModuleCatalogEntry): TypedModule {
  const module = modulesByUri.get(entry.uri);
  if (module === undefined) {
    throw new Error(`Missing typed artifact for ${entry.id}`);
  }
  return module;
}

describe('standard module catalog', () => {
  it('provides unique identities and searchable domain metadata', async () => {
    const folders = await readdir(new URL('../modules/', import.meta.url), { withFileTypes: true });
    expect(moduleCatalog.map((entry): string => entry.id).sort()).toEqual(
      folders
        .filter((entry): boolean => entry.isDirectory())
        .map((entry): string => entry.name)
        .sort(),
    );
    expect(new Set(moduleCatalog.map((entry): string => entry.id)).size).toBe(moduleCatalog.length);
    expect(new Set(moduleCatalog.map((entry): string => entry.uri)).size).toBe(moduleCatalog.length);
    expect(getModuleCatalogEntry(' GROCERIES ')?.id).toBe('groceries');
    expect(getModuleCatalogEntry('Stock Watchlists')?.id).toBe('stock-watchlists');
    expect(getModuleCatalogEntry('https://enbox.id/modules/credentials/v1')?.id).toBe('credentials');
    expect(getModuleCatalogEntry('missing')).toBeUndefined();
    expect(searchModuleCatalog('   ')).toBe(moduleCatalog);
    expect(searchModuleCatalog('milk').map((entry): string => entry.id)).toContain('groceries');
    expect(searchModuleCatalog('owned positions').map((entry): string => entry.id)).toContain('investment-holdings');
    expect(searchModuleCatalog('not-a-module-9173')).toEqual([]);
  });

  it('ships an issuer-signed demonstration credential matching its stored metadata', async () => {
    const entry = getModuleCatalogEntry('credentials')!;
    const artifact = entry.examples.find((example): boolean => example.path === 'credential/artifact')!;
    const metadata = entry.examples.find((example): boolean => example.path === 'credential')!.data as globalThis.Record<string, unknown>;
    const token = Buffer.from(artifact.data as string, 'base64').toString('utf8');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('vc+jwt');
    expect(metadata.issuer).toBe(payload.issuer);
    expect(metadata.subjectIds).toEqual([payload.credentialSubject.id]);
    const resolution = await DidJwk.resolve(payload.issuer);
    const method = resolution.didDocument!.verificationMethod![0];
    expect(method.id).toBe(header.kid);
    expect(method.publicKeyJwk!.d).toBeUndefined();
    expect(
      await Ed25519.verify({
        key       : method.publicKeyJwk!,
        data      : new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
        signature : Uint8Array.from(Buffer.from(parts[2], 'base64url')),
      }),
    ).toBe(true);
  });

  for (const entry of moduleCatalog) {
    describe(entry.name, () => {
      it('matches individual definitions, schemas, examples, and resolved local paths', async () => {
        const base = new URL(`../modules/${entry.id}/`, import.meta.url);
        const definition = JSON.parse(await readFile(new URL('definition.json', base), 'utf8'));
        const examples = JSON.parse(await readFile(new URL('examples.json', base), 'utf8'));
        const module = moduleFor(entry);
        expect(module.definition).toEqual(definition);
        expect(entry.definition).toEqual(definition);
        expect(entry.examples).toEqual(examples);
        const graph = resolveTypedModuleGraph(module);
        const paths = [...graph.nodesByDeclaredPath.values()]
          .filter((node): boolean => node.kind === 'record')
          .map((node): string => node.declaringModulePath)
          .sort();
        expect(entry.records.map((record): string => record.path).sort()).toEqual(paths);
        expect(entry.examples.map((example): string => example.path).sort()).toEqual(paths);
        expect(Object.keys(module.codecs).sort()).toEqual([...new Set(entry.records.map((record): string => record.type))].sort());
        for (const record of entry.records) {
          expect(definition.types[record.type].encryptionRequired ?? false).toBe(record.encryptionRequired);
          if (record.schema !== undefined) {
            const schemaName = record.type.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
            const schema = JSON.parse(await readFile(new URL(`schemas/${schemaName}.json`, base), 'utf8'));
            expect(record.schema).toEqual(schema);
            expect(record.schemaUri).toBe(schema.$id);
            expect(definition.types[record.type].schema).toBe(schema.$id);
            expect(schema.additionalProperties).toBe(false);
          }
        }
      });

      it('encodes and decodes every supplied record example with validating codecs', async () => {
        const codecs: CodecMap = moduleFor(entry).codecs;
        for (const example of entry.examples) {
          const type = example.path.split('/').at(-1)!;
          const value = exampleValue(example);
          const encoded = await codecs[type].encode(value, { modulePath: example.path });
          const decoded = await codecs[type].decode(recordData(encoded.data), encoded.dataFormat, { modulePath: example.path });
          await expectExample(decoded, value, example);
        }
      });

      it('rejects missing required fields, invalid shapes, and unknown fields on encode and decode', async () => {
        const codecs: CodecMap = moduleFor(entry).codecs;
        for (const record of entry.records.filter((record): boolean => record.schema !== undefined)) {
          const example = entry.examples.find((example): boolean => example.path === record.path)!;
          const data = example.data as globalThis.Record<string, unknown>;
          const invalid: unknown[] = [null, [], { ...data, unexpectedField: 'must not be accepted' }];
          for (const field of (record.schema!.required as string[]) ?? []) {
            const missing = structuredClone(data);
            delete missing[field];
            invalid.push(missing);
          }
          for (const value of invalid) {
            expect(() => codecs[record.type].encode(value, { modulePath: record.path })).toThrow(RecordValidationError);
            await expect(
              codecs[record.type].decode(recordData(new Blob([JSON.stringify(value)], { type: 'application/json' })), 'application/json', {
                modulePath: record.path,
              }),
            ).rejects.toBeInstanceOf(RecordValidationError);
          }
        }
      });
    });
  }
});

describe('domain constraints', () => {
  const invalid = [
    { id: 'groceries', type: 'item', data: { name: 'Milk', state: 'needed', quantity: { value: '-1', unit: 'litre' } } },
    {
      id   : 'transactions',
      type : 'transaction',
      data : { kind: 'expense', amount: { amount: '1.2.3', currency: 'USD' }, occurredAt: '2026-01-01T00:00:00Z' },
    },
    {
      id   : 'transactions',
      type : 'transaction',
      data : { kind: 'expense', amount: { amount: '12', currency: 'usd' }, occurredAt: '2026-01-01T00:00:00Z' },
    },
    { id: 'events', type: 'event', data: { title: 'Invalid date', startsAt: '2026-02-30T12:00:00Z' } },
    { id: 'events', type: 'event', data: { title: 'Mixed representations', startsAt: '2026-01-01T12:00:00Z', startsOn: '2026-01-01' } },
    { id: 'tasks', type: 'state', data: { task: { recordId: 'task' }, alerts: [{ id: 'missing-trigger' }] } },
    { id: 'bookmarks', type: 'bookmark', data: { title: 'Ambiguous', url: 'https://example.com', record: { recordId: 'record' } } },
    { id: 'identity-documents', type: 'review', data: { reviewedAt: '2026-01-01T00:00:00Z', decision: 'corrected' } },
    {
      id   : 'credentials',
      type : 'presentation',
      data : { verifier: 'https://example.com', requestedAt: '2026-01-01T00:00:00Z', state: 'sent' },
    },
    { id: 'online-accounts', type: 'account', data: { service: 'Example', state: 'active', password: 'not-an-account-field' } },
    { id: 'preferences', type: 'accessibility', data: { notes: 'No actual setting supplied' } },
  ];
  for (const [index, sample] of invalid.entries()) {
    it(`rejects invalid ${sample.id}/${sample.type} input ${index + 1}`, () => {
      const entry = getModuleCatalogEntry(sample.id)!;
      expect(() => moduleFor(entry).codecs[sample.type].encode(sample.data)).toThrow(RecordValidationError);
    });
  }
});

describe('schema references and access boundaries', () => {
  it('resolves embedded references for DID-relative and explicitly located file links', async () => {
    const files = moduleFor(getModuleCatalogEntry('files')!).codecs.file;
    const links = [
      { recordId: 'revision' },
      { recordId: 'revision', tenantDid: 'did:example:alice', moduleUri: 'https://enbox.id/modules/files/v1', modulePath: 'file/content' },
    ];
    for (const currentContent of links) {
      const value = { name: 'document.txt', mediaType: 'text/plain', currentContent, source: { kind: 'import', record: currentContent } };
      const encoded = await files.encode(value);
      expect(await files.decode(recordData(encoded.data), encoded.dataFormat)).toEqual(value);
    }
    for (const record of [
      {},
      { recordId: 'revision', tenantDid: 'alice' },
      { recordId: 'revision', moduleUri: 'not a URI' },
      { recordId: 'revision', unexpected: true },
    ]) {
      expect(() => files.encode({ name: 'document.txt', mediaType: 'text/plain', currentContent: record })).toThrow(RecordValidationError);
      expect(() => files.encode({ name: 'document.txt', mediaType: 'text/plain', source: { kind: 'import', record } })).toThrow(
        RecordValidationError,
      );
    }
  });

  it('keeps viewer content authority read-only and membership mutation recipient-scoped', () => {
    for (const entry of moduleCatalog) {
      for (const record of entry.records) {
        const label = `${entry.id}/${record.path}`;
        for (const action of record.actions) {
          if (action.role?.endsWith('/viewer')) {
            expect(action.can, label).toEqual(['read']);
          }
          if (record.role && action.can.some((can): boolean => can !== 'read')) {
            expect(action.role, label).toBeUndefined();
            expect(action.who, label).toBe('recipient');
            expect(action.of === undefined || action.of === record.path, label).toBe(true);
            expect(action.can, label).toEqual(['co-delete']);
          }
          if (record.immutable && !record.role) {
            expect(action.can, label).not.toContain('co-delete');
            expect(action.can, label).not.toContain('co-update');
          }
        }
      }
    }
  });

  it('does not let member pruning of an ancestor bypass immutable contribution protections', () => {
    for (const entry of moduleCatalog) {
      const graph = resolveTypedModuleGraph(moduleFor(entry));
      for (const record of entry.records.filter((record): boolean => record.immutable && !record.role)) {
        let parent = graph.nodesByDeclaredPath.get(record.path)!.expectedParent;
        while (parent !== undefined) {
          const provider = getModuleCatalogEntry(parent.owningModuleUri)!;
          const ancestor = provider.records.find((record): boolean => record.path === parent!.owningModulePath)!;
          for (const action of ancestor.actions.filter((action): boolean => action.role !== undefined)) {
            expect(action.can, `${entry.id}/${record.path} through ${provider.id}/${ancestor.path}`).not.toContain('prune');
            expect(action.can, `${entry.id}/${record.path} through ${provider.id}/${ancestor.path}`).not.toContain('co-prune');
          }
          parent = resolveTypedModuleGraph(moduleFor(provider)).nodesByDeclaredPath.get(ancestor.path)!.expectedParent;
        }
      }
    }
  });
});
