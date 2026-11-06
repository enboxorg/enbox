import type { DwnApi } from '../src/dwn-api.js';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { defineModule } from '../src/define-module.js';
import { Module } from '../src/module.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const Extra = defineModule({
  definition: {
    module    : 'https://example.com/modules/readiness-extra',
    published : true,
    types     : { extra: { dataFormats: ['text/plain'] } },
    structure : { extra: {} },
  },
  codecs: { extra: recordCodecs.text() },
});
const Provider = defineModule({
  definition: {
    module    : 'https://example.com/modules/readiness-provider',
    published : true,
    types     : { note: { dataFormats: ['text/plain'] }, unused: { dataFormats: ['text/plain'] } },
    structure : { note: {}, unused: {} },
  },
  codecs: { note: recordCodecs.text(), unused: recordCodecs.text() },
});
const Consumer = defineModule({
  definition: {
    module    : 'https://example.com/modules/readiness-consumer',
    published : true,
    uses      : { provider: Provider.definition.module },
    types     : { comment: { dataFormats: ['text/plain'] } },
    structure : { note: { $ref: 'provider:note', comment: {} } },
  },
  codecs       : { comment: recordCodecs.text() },
  dependencies : { provider: Provider },
});

function fixture(provider: ModuleDefinition): {
  dwn: DwnApi;
  definitions: Map<string, ModuleDefinition>;
  queries: string[];
} {
  const definitions = new Map<string, ModuleDefinition>([
    [provider.module, provider],
    [Consumer.definition.module, Consumer.definition],
  ]);
  const queries: string[] = [];
  const dwn = {
    isDelegate : false,
    modules    : {
      query: async ({ filter }: { filter: { module: string } }): Promise<unknown> => {
        queries.push(filter.module);
        const definition = definitions.get(filter.module);
        return { status: { code: 200, detail: 'OK' }, modules: definition === undefined ? [] : [{ definition }] };
      },
      configure: async (): Promise<never> => { throw new Error('Existing providers must not be configured.'); },
    },
    records: {
      query: async (): Promise<unknown> => ({ status: { code: 200, detail: 'OK' }, records: [] }),
    },
  } as unknown as DwnApi;
  return { dwn, definitions, queries };
}

describe('composition readiness against compatible installed providers', () => {
  it('accepts removal of an unrelated packaged provider path', async () => {
    const installed = {
      ...Provider.definition,
      types     : { note: Provider.definition.types.note },
      structure : { note: {} },
    };
    const { dwn } = fixture(installed);
    const typed = new TypedEnbox(dwn, Consumer);
    expect((await typed.verifyInstalled()).status).toBe('up-to-date');
    expect((await typed.records.query('note/comment', { within: 'notecontext' })).records).toEqual([]);
  });

  it('loads an unrelated new installed dependency without requiring a packaged codec artifact', async () => {
    const installed = {
      ...Provider.definition,
      uses      : { extra: Extra.definition.module },
      structure : { note: {}, other: { $ref: 'extra:extra', unused: {} } },
    };
    const { dwn, definitions, queries } = fixture(installed);
    definitions.set(Extra.definition.module, Extra.definition);
    const typed = new TypedEnbox(dwn, Consumer);
    expect((await typed.verifyInstalled()).status).toBe('up-to-date');
    expect(queries).toContain(Extra.definition.module);
    expect((await typed.records.query('note/comment', { within: 'notecontext' })).records).toEqual([]);
  });

  it('does not prepare stale imports removed from an already installed provider', async () => {
    const staleProvider = defineModule({
      definition: {
        ...Provider.definition,
        uses      : { extra: Extra.definition.module },
        structure : { ...Provider.definition.structure, other: { $ref: 'extra:extra', unused: {} } },
      },
      codecs       : Provider.codecs,
      dependencies : { extra: Extra },
    });
    const consumer = defineModule({
      definition   : Consumer.definition,
      codecs       : Consumer.codecs,
      dependencies : { provider: staleProvider },
    });
    const { dwn, queries } = fixture(Provider.definition);
    const typed = new TypedEnbox(dwn, consumer);
    expect((await typed.records.query('note/comment', { within: 'notecontext' })).records).toEqual([]);
    expect(queries).not.toContain(Extra.definition.module);
  });

  it('still rejects a changed representation at an imported provider path', async () => {
    const { dwn } = fixture({
      ...Provider.definition,
      types: { ...Provider.definition.types, note: { dataFormats: ['application/json'] } },
    });
    const typed = new TypedEnbox(dwn, Consumer);
    await expect(typed.verifyInstalled()).rejects.toThrow('incompatible attachment');
    await expect(typed.records.query('note/comment', { within: 'notecontext' })).rejects.toThrow('incompatible attachment');
  });

  it('rejects a changed local codec representation in a composed binding before querying records', async () => {
    const { dwn, definitions } = fixture(Provider.definition);
    definitions.set(Consumer.definition.module, {
      ...Consumer.definition,
      types: { comment: { dataFormats: ['application/json'] } },
    });
    const typed = new TypedEnbox(dwn, Consumer);
    await expect(typed.records.query('note/comment', { within: 'notecontext' }))
      .rejects.toThrow('changed the consumed representation at \'note/comment\'');
  });

  it('imports the actual signed provider closure for a delegate without provider codecs or extra grants', async () => {
    const provider = {
      ...Provider.definition,
      uses      : { extra: Extra.definition.module },
      structure : { note: {}, other: { $ref: 'extra:extra', unused: {} } },
    };
    const remote = new Map<string, ModuleDefinition>([
      [provider.module, provider], [Extra.definition.module, Extra.definition], [Consumer.definition.module, Consumer.definition],
    ]);
    const local = new Map<string, ModuleDefinition>();
    const imported: string[] = [];
    let denyExtra = true;
    const signed = (definition: ModuleDefinition): Module => new Module({
      authorization : { signature: 'wallet-signature' },
      descriptor    : { interface: 'Modules', method: 'Configure', definition },
    } as unknown as ConstructorParameters<typeof Module>[0]);
    const dwn = {
      connectedDid : 'did:example:owner',
      isDelegate   : true,
      modules      : {
        query: async ({ filter, from }: { filter: { module: string }; from?: string }): Promise<unknown> => {
          if (from !== undefined && filter.module === Extra.definition.module && denyExtra) {
            return { status: { code: 401, detail: 'Existing authority does not allow this metadata query.' }, modules: [] };
          }
          const definition = (from === undefined ? local : remote).get(filter.module);
          return { status: { code: 200, detail: 'OK' }, modules: definition === undefined ? [] : [signed(definition)] };
        },
      },
      importModuleConfiguration: async (message: ReturnType<Module['toJSON']>): Promise<unknown> => {
        expect(message.authorization).toEqual({ signature: 'wallet-signature' });
        imported.push(message.descriptor.definition.module);
        local.set(message.descriptor.definition.module, message.descriptor.definition);
        return { status: { code: 202, detail: 'Accepted' } };
      },
      records: { query: async (): Promise<unknown> => ({ status: { code: 200, detail: 'OK' }, records: [] }) },
    } as unknown as DwnApi;
    const typed = new TypedEnbox(dwn, Consumer);
    await expect(typed.records.query('note/comment', { within: 'notecontext' })).rejects.toMatchObject({ status: { code: 401 } });
    expect(imported).toEqual([]);
    denyExtra = false;
    expect((await typed.records.query('note/comment', { within: 'notecontext' })).records).toEqual([]);
    expect(imported.indexOf(Extra.definition.module)).toBeLessThan(imported.indexOf(provider.module));
    expect(imported.indexOf(provider.module)).toBeLessThan(imported.indexOf(Consumer.definition.module));
    expect(local.get(provider.module)).toEqual(provider);
  });

});
