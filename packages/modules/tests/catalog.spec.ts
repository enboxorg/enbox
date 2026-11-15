import type { ModuleCatalogEntry, ModuleRecordExample } from '../src/catalog-types.js';
import type { RecordCodec, RecordData, TypedModule } from '@enbox/api';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';
import { readFile } from 'node:fs/promises';
import { RecordValidationError } from '@enbox/api';
import { resolveTypedModuleGraph } from '@enbox/api/advanced';
import { describe, expect, it } from 'bun:test';

import { getModuleCatalogEntry, moduleCatalog, searchModuleCatalog, standardModules } from '../src/catalog.js';

const modulesByUri = new Map(standardModules.map((module): [string, TypedModule] => [module.definition.module, module]));
type CodecMap = globalThis.Record<string, RecordCodec<unknown>>;

/** Real Blob/stream access with the same consumption contract as record.data. */
function recordData(blob: Blob): RecordData {
  const stream = async (): Promise<ReadableStream> => blob.stream();
  return {
    stream,
    blob  : async (): Promise<Blob> => blob,
    bytes : async (): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer()),
    json  : async (): Promise<unknown> => JSON.parse(await blob.text()),
    text  : async (): Promise<string> => blob.text(),
    then  : (onFulfilled, onRejected): Promise<ReadableStream> => stream().then(onFulfilled, onRejected),
    catch : (onRejected): Promise<ReadableStream> => stream().catch(onRejected),
  };
}

function exampleValue(example: ModuleRecordExample): unknown {
  if (example.encoding === 'json') {
    return structuredClone(example.data);
  }
  const bytes = Uint8Array.from(Buffer.from(example.data as string, 'base64'));
  return example.dataFormat === undefined ? bytes : new Blob([bytes], { type: example.dataFormat });
}

function moduleFor(entry: ModuleCatalogEntry): TypedModule {
  const module = modulesByUri.get(entry.uri);
  if (module === undefined) {
    throw new Error(`Missing typed artifact for ${entry.id}`);
  }
  return module;
}

describe('standard module catalog', () => {
  it('provides unique identities and searchable domain metadata', () => {
    expect(moduleCatalog).toHaveLength(67);
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
    expect(await Ed25519.verify({
      key       : method.publicKeyJwk!,
      data      : new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signature : Uint8Array.from(Buffer.from(parts[2], 'base64url')),
    })).toBe(true);
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
          expect(definition.types[record.type].encryptionRequired).toBe(record.encryptionRequired);
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
          if (decoded instanceof Blob && value instanceof Blob) {
            expect(decoded.type).toBe(value.type);
            expect(await decoded.bytes()).toEqual(await value.bytes());
          } else {
            expect(decoded).toEqual(value);
          }
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
