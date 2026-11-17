import type { PayloadSchema, SchemaValue } from '../src/catalog-types.js';

import crosswalks from '../directory/crosswalks.json' with { type: 'json' };
import { getModuleCatalogEntry } from '../src/catalog.js';
import { describe, expect, it } from 'bun:test';

function schemaObject(value: SchemaValue | undefined): PayloadSchema {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a schema object.');
  }
  return value as PayloadSchema;
}

/** Navigate the dotted notation used by the crosswalk. Published schemas have local pointers. */
function fieldInSchema(root: PayloadSchema, field: string): PayloadSchema {
  let schema = root;
  for (const segment of field.split('.')) {
    if (typeof schema.$ref === 'string') {
      if (!schema.$ref.startsWith('#/definitions/')) {
        throw new TypeError(`Unexpected schema reference ${schema.$ref}`);
      }
      schema = schemaObject(schemaObject(root.definitions)[schema.$ref.slice('#/definitions/'.length)]);
    }
    const array = segment.endsWith('[]');
    schema = schemaObject(schemaObject(schema.properties)[array ? segment.slice(0, -2) : segment]);
    if (array) {
      expect(schema.type).toBe('array');
      schema = schemaObject(schema.items);
    }
  }
  return schema;
}

describe('published field crosswalks', () => {
  it('maps each external field to an existing payload field on the named module and path', () => {
    expect(crosswalks.kind).toBe('mapping-guidance');
    for (const profile of crosswalks.profiles) {
      const entry = getModuleCatalogEntry(profile.module);
      const record = entry?.records.find((candidate): boolean => candidate.path === profile.path);
      expect(record?.schema, profile.module + '/' + profile.path).toBeDefined();
      expect(profile.sources.length).toBeGreaterThan(0);
      for (const source of profile.sources) {
        expect(new URL(source).protocol).toBe('https:');
      }
      expect(profile.limits.trim().length).toBeGreaterThan(0);
      for (const [external, field] of Object.entries(profile.fields)) {
        expect(external.trim()).toBeTruthy();
        expect(fieldInSchema(record!.schema!, field)).toBeDefined();
      }
    }
  });
});
