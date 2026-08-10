import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { mergeRecordPatch } from '../src/record-patch.js';
import { recordCodecs } from '../src/record-codec.js';

describe('mergeRecordPatch()', () => {
  it('should preserve an own __proto__ patch key as an own enumerable property', () => {
    const patch = JSON.parse('{ "__proto__": { "polluted": true }, "note": "kept" }');
    const merged = mergeRecordPatch<globalThis.Record<string, unknown>>({ existing: 1 }, patch);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(true);
    expect((merged as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(merged))).toEqual(
      JSON.parse('{ "existing": 1, "__proto__": { "polluted": true }, "note": "kept" }')
    );
  });

  it('should keep undefined-ignore and null-delete semantics', () => {
    const merged = mergeRecordPatch<globalThis.Record<string, unknown>>(
      { drop: 'b', keep: 'a' },
      { added: 'c', drop: null, missing: undefined },
    );

    expect(merged).toEqual({ added: 'c', keep: 'a' });
  });
});

describe('TypedEnbox.records.patch() integration', () => {
  it('stores the complete shallow-merged value through a real local DWN', async () => {
    const definition = {
      published : false,
      protocol  : 'https://example.com/protocols/record-patch-integration',
      types     : {
        note: {
          schema      : 'https://example.com/schemas/record-patch-integration-note',
          dataFormats : ['application/json'],
        },
      },
      structure: { note: {} },
    } as const satisfies ProtocolDefinition;
    type Note = {
      body: string;
      meta: { a: number; b?: number };
      subtitle?: string;
      title: string;
    };
    const protocol = defineProtocol(definition, { note: recordCodecs.json<Note>() });
    const context = await createEnboxTestContext({
      application: defineApplicationManifest({ protocols: [protocol] }),
    });

    try {
      const notes = context.enbox.using(protocol);
      const created = await notes.records.create('note', {
        data: {
          body     : 'kept',
          meta     : { a: 1, b: 2 },
          subtitle : 'remove me',
          title    : 'before',
        },
      });

      const patched = await notes.records.patch('note', created.id, {
        body     : undefined,
        meta     : { a: 9 },
        subtitle : null,
        title    : 'after',
      });

      expect(await patched.value()).toEqual({ body: 'kept', meta: { a: 9 }, title: 'after' });
      expect(await notes.records.read('note', created.id).then(record => record?.value()))
        .toEqual({ body: 'kept', meta: { a: 9 }, title: 'after' });
    } finally {
      await context.close();
    }
  });

  it('re-encrypts the complete merged value through a real local DWN', async () => {
    const definition = {
      published : false,
      protocol  : 'https://example.com/protocols/encrypted-record-patch-integration',
      types     : {
        secret: {
          schema             : 'https://example.com/schemas/encrypted-record-patch-integration-secret',
          dataFormats        : ['application/json'],
          encryptionRequired : true,
        },
      },
      structure: { secret: {} },
    } as const satisfies ProtocolDefinition;
    type Secret = { pin: string; title: string };
    const protocol = defineProtocol(definition, { secret: recordCodecs.json<Secret>() });
    const context = await createEnboxTestContext({
      application: defineApplicationManifest({ protocols: [protocol] }),
    });

    try {
      const secrets = context.enbox.using(protocol);
      const created = await secrets.records.create('secret', {
        data: { pin: '1234', title: 'before' },
      });
      const originalIv = created.encryption?.initializationVector;

      const patched = await secrets.records.patch('secret', created.id, { title: 'after' });

      expect(originalIv).toBeDefined();
      expect(patched.encryption?.initializationVector).not.toBe(originalIv);
      expect(await patched.value()).toEqual({ pin: '1234', title: 'after' });
    } finally {
      await context.close();
    }
  });
});
