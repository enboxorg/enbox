import type { DwnApi } from '../src/dwn-api.js';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodec } from '../src/record-codec.js';
import type { TypedModule } from '../src/module-types.js';

import { describe, expect, it } from 'bun:test';

import { compileRecordQuery } from '../src/record-query.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { defineModule, isTypedModule, orderTypedModuleDependencies } from '../src/define-module.js';

const BaseDefinition = {
  module    : 'https://example.com/modules/composition-base',
  published : true,
  types     : {
    workspace : { dataFormats: ['application/json'] },
    member    : { dataFormats: ['application/json'] },
    note      : { dataFormats: ['application/json'] },
  },
  structure: {
    workspace: {
      member : { $role: true },
      note   : {},
    },
  },
} as const satisfies ModuleDefinition;

const BaseModule = defineModule({
  definition : BaseDefinition,
  codecs     : {
    workspace : recordCodecs.json<{ name: string }>(),
    member    : recordCodecs.json<object>(),
    note      : recordCodecs.json<{ title: string }>(),
  },
});

const DiscussionDefinition = {
  module    : 'https://example.com/modules/composition-discussion',
  published : true,
  uses      : { base: BaseDefinition.module },
  types     : {
    comment: {
      schema      : 'https://example.com/schemas/comment',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    note: {
      $ref    : 'base:workspace/note',
      comment : {
        $actions: [{ role: 'base:workspace/member', can: ['create', 'read'] }],
      },
    },
  },
} as const satisfies ModuleDefinition;

function discussion(): TypedModule<typeof DiscussionDefinition, {
  comment: RecordCodec<{ text: string }>;
}, { base: typeof BaseModule }> {
  return defineModule({
    definition   : DiscussionDefinition,
    codecs       : { comment: recordCodecs.json<{ text: string }>() },
    dependencies : { base: BaseModule },
  });
}

describe('typed module composition', () => {
  it('resolves a deep foreign parent and uses its physical context depth', () => {
    const module = discussion();
    expect(isTypedModule(module)).toBe(true);
    expect(Object.keys(module.codecs)).toEqual(['comment']);
    expect(module.resolvedGraph.nodesByDeclaredPath.get('note')).toMatchObject({
      kind             : 'ref',
      owningModuleUri  : BaseDefinition.module,
      owningModulePath : 'workspace/note',
    });
    expect(module.resolvedGraph.nodesByDeclaredPath.get('note/comment')).toMatchObject({
      physicalDepth       : 3,
      parentPhysicalDepth : 2,
      owningModuleUri     : DiscussionDefinition.module,
    });
    expect(compileRecordQuery(module.resolvedGraph, 'note/comment', { within: 'W/N/C' }).filter).toEqual({
      module     : DiscussionDefinition.module,
      modulePath : 'note/comment',
      contextId  : 'W/N/C',
      schema     : 'https://example.com/schemas/comment',
    });
    expect(() => compileRecordQuery(module.resolvedGraph, 'note')).toThrow('not a locally owned record path');
    expect(() => compileRecordQuery(module.resolvedGraph, 'note/comment', { within: 'W/N/C/X' }))
      .toThrow('cannot be deeper');
  });

  it('requires exactly the direct aliases and rejects a mismatched provider URI', () => {
    const codecs = { comment: recordCodecs.json<unknown>() };
    expect(() => defineModule({ definition: DiscussionDefinition, codecs } as never))
      .toThrow('dependencies must exactly match');
    expect(() => defineModule({
      definition   : DiscussionDefinition,
      codecs,
      dependencies : { base: BaseModule, extra: BaseModule },
    } as never)).toThrow('dependencies must exactly match');
    expect(() => defineModule({
      definition   : { ...DiscussionDefinition, uses: { base: 'https://example.com/wrong' } },
      codecs,
      dependencies : { base: BaseModule },
    } as never)).toThrow('dependency \'base\' must provide');
  });

  it('keeps a same-named local type separate from the imported attachment', () => {
    const definition = {
      ...DiscussionDefinition,
      types: {
        ...DiscussionDefinition.types,
        folder : { dataFormats: ['application/json'] },
        note   : { dataFormats: ['text/plain'] },
      },
      structure: {
        ...DiscussionDefinition.structure,
        folder: { note: {} },
      },
    } as const satisfies ModuleDefinition;
    const text = recordCodecs.text();
    const module = defineModule({
      definition,
      codecs: {
        comment : recordCodecs.json<unknown>(),
        folder  : recordCodecs.json<unknown>(),
        note    : text,
      },
      dependencies: { base: BaseModule },
    });
    expect(module.codecs.note).toBe(text);
    expect(module.resolvedGraph.nodesByDeclaredPath.get('note')?.recordType.dataFormats).toEqual(['application/json']);
    expect(module.resolvedGraph.nodesByDeclaredPath.get('folder/note')?.recordType.dataFormats).toEqual(['text/plain']);
  });

  it('does not require codecs for unused types or imported attachment nodes', () => {
    expect(() => defineModule({
      definition   : { ...DiscussionDefinition, types: { ...DiscussionDefinition.types, unused: {} } },
      codecs       : { comment: recordCodecs.json<unknown>() },
      dependencies : { base: BaseModule },
    })).not.toThrow();
    expect(() => defineModule({
      definition   : DiscussionDefinition,
      codecs       : { comment: recordCodecs.json<unknown>(), note: recordCodecs.json<unknown>() },
      dependencies : { base: BaseModule },
    } as never)).toThrow('unexpected: note');
  });

  it('snapshots authored metadata and keeps plaintext role providers free of managed contexts', () => {
    const definition = structuredClone(BaseDefinition) as ModuleDefinition;
    const module = defineModule({ definition, codecs: BaseModule.codecs });
    definition.types.note.dataFormats = ['text/plain'];
    expect(module.definition.types.note.dataFormats).toEqual(['application/json']);
    expect(Object.isFrozen(module.definition.structure.workspace)).toBe(true);
    expect(module.definition.structure.enboxContextFollow).toBeUndefined();
    expect(isTypedModule(module)).toBe(true);
  });

  it('resolves injected sharing paths only for locally rooted encrypted sharing modules', () => {
    const definition = {
      ...BaseDefinition,
      types     : { ...BaseDefinition.types, workspace: { dataFormats: ['application/json'], encryptionRequired: true } },
      structure : {
        workspace: {
          ...BaseDefinition.structure.workspace,
          $actions: [{ role: 'workspace/member', can: ['read'] }],
        },
      },
    } as const satisfies ModuleDefinition;
    const module = defineModule({ definition, codecs: BaseModule.codecs });
    expect(module.resolvedGraph.nodesByDeclaredPath.get('enboxContextFollow')?.kind).toBe('record');
    expect(isTypedModule(module)).toBe(true);

    const extension = defineModule({
      definition: {
        ...DiscussionDefinition,
        types: {
          comment : { dataFormats: ['application/json'], encryptionRequired: true },
          reader  : { dataFormats: ['application/json'] },
        },
        structure: {
          note: {
            $ref    : 'base:workspace/note',
            comment : {
              $actions : [{ role: 'note/comment/reader', can: ['read'] }],
              reader   : { $role: true },
            },
          },
        },
      },
      codecs       : { comment: recordCodecs.json<unknown>(), reader: recordCodecs.json<object>() },
      dependencies : { base: BaseModule },
    });
    expect(extension.definition.structure.enboxContextFollow).toBeUndefined();
    expect(isTypedModule(extension)).toBe(true);
  });

  it('orders providers once before consumers without merging incompatible artifacts', () => {
    const child = discussion();
    expect(orderTypedModuleDependencies([child, BaseModule]).map(module => module.definition.module))
      .toEqual([BaseDefinition.module, DiscussionDefinition.module]);
    const different = defineModule({
      definition : { ...BaseDefinition, published: false },
      codecs     : BaseModule.codecs,
    });
    expect(() => orderTypedModuleDependencies([child, different])).toThrow('conflicting dependency definitions');
  });

  it('reports missing keys in an installed plaintext role provider during verification', async () => {
    const dwn = {
      isDelegate : false,
      modules    : {
        query: async (): Promise<unknown> => ({
          status  : { code: 200, detail: 'OK' },
          modules : [{ definition: BaseDefinition }],
        }),
      },
    } as unknown as DwnApi;
    const typed = new TypedEnbox(dwn, discussion());
    await expect(typed.verifyInstalled()).rejects.toThrow('installed dependency \'https://example.com/modules/composition-base\' is missing $keyAgreement');
  });

  it('does not overwrite an updated provider when its required keys are incomplete', async () => {
    let configurations = 0;
    const dwn = {
      isDelegate : false,
      modules    : {
        query: async (): Promise<unknown> => ({
          status  : { code: 200, detail: 'OK' },
          modules : [{ definition: { ...BaseDefinition, published: false } }],
        }),
        configure: async (): Promise<unknown> => {
          configurations++;
          return { status: { code: 202, detail: 'Accepted' } };
        },
      },
    } as unknown as DwnApi;
    const typed = new TypedEnbox(dwn, discussion());
    await expect(typed.records.query('note/comment', { within: 'W/N' })).rejects.toThrow('is missing $keyAgreement');
    expect(configurations).toBe(0);
  });
});
