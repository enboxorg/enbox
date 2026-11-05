import type { RecordCodecMap } from '../src/record-codec.js';
import type { TypedModule } from '../src/module-types.js';
import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { recordCodecs } from '../src/record-codec.js';

function createBaseModule(name: string, path: readonly string[]): TypedModule {
  const definition: ModuleDefinition = {
    module    : `https://example.com/modules/typed-integration/${name}/base`,
    published : true,
    types     : {},
    structure : {},
  };
  const codecs: RecordCodecMap = {};
  let structure = definition.structure;
  for (const segment of path) {
    definition.types[segment] = { dataFormats: ['application/json'] };
    codecs[segment] = recordCodecs.json<unknown>();
    const node: ModuleRuleSet = {};
    structure[segment] = node;
    structure = node as { [key: string]: ModuleRuleSet };
  }
  return defineModule({ definition, codecs, dependencies: {} });
}

describe('typed composition against a local DWN', () => {
  for (const example of [
    { name: 'notes', parent: ['notebook', 'note'], attachment: 'note', child: 'comment' },
    { name: 'projects', parent: ['workspace', 'board', 'task'], attachment: 'task', child: 'comment' },
    { name: 'chat', parent: ['team', 'channel', 'message'], attachment: 'message', child: 'file' },
    { name: 'events', parent: ['event', 'session'], attachment: 'session', child: 'comment' },
  ]) {
    it(`installs ${example.name} dependencies and round-trips the resolved physical context`, async () => {
      const base = createBaseModule(example.name, example.parent);
      const childPath = `${example.attachment}/${example.child}`;
      const definition: ModuleDefinition = {
        module    : `https://example.com/modules/typed-integration/${example.name}/extension`,
        published : true,
        uses      : { base: base.definition.module },
        types     : { [example.child]: { dataFormats: ['application/json'] } },
        structure : {
          [example.attachment]: {
            $ref            : `base:${example.parent.join('/')}`,
            [example.child] : {},
          },
        },
      };
      const extension = defineModule({
        definition,
        codecs       : { [example.child]: recordCodecs.json<{ text: string }>() },
        dependencies : { base },
      });
      const application = defineApplicationManifest({ modules: [extension] });
      const context = await createEnboxTestContext({ application });

      try {
        const baseApi = context.enbox.using(base);
        const extensionApi = context.enbox.using(extension);
        expect((await baseApi.verifyInstalled()).status).toBe('up-to-date');
        expect((await extensionApi.verifyInstalled()).status).toBe('up-to-date');

        let parentContextId: string | undefined;
        for (let depth = 1; depth <= example.parent.length; depth++) {
          const parent = await baseApi.records.create(example.parent.slice(0, depth).join('/'), {
            data: { name: example.parent[depth - 1] },
            ...(parentContextId === undefined ? {} : { parentContextId }),
          });
          parentContextId = parent.contextId;
        }
        const record = await extensionApi.records.create(childPath, {
          parentContextId,
          data: { text: example.name },
        });
        expect(record.module).toBe(definition.module);
        expect(record.modulePath).toBe(childPath);
        expect(record.contextId.split('/')).toHaveLength(example.parent.length + 1);

        const page = await extensionApi.records.query(childPath, { within: record.contextId });
        expect(page.records).toHaveLength(1);
        expect(await page.records[0].value()).toEqual({ text: example.name });
        expect(await extensionApi.records.count(childPath, { within: parentContextId })).toBe(1);
        await expect(extensionApi.records.create(childPath, {
          parentContextId : `${parentContextId}/extra`,
          data            : { text: 'wrong parent' },
        })).rejects.toThrow('direct parent');
      } finally {
        await context.close();
      }
    });
  }
});
