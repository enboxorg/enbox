import type { PayloadSchema, SchemaValue } from '../catalog-types.js';

export type SchemaRegistry = Readonly<Record<string, PayloadSchema>>;
export type SchemaBundleOptions = { definitionPrefix?: string };

const annotations = new Set(['$id', '$schema', 'title', 'description', 'examples', '$comment']);
const literalValues = new Set(['examples', 'default', 'enum', 'const']);

function isObject(value: SchemaValue | undefined): value is PayloadSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bundle registered value schemas into one self-contained Draft-07 document.
 * Local pointers in imported fragments are rebound to their embedded location.
 * Registry import cycles and nested identifier scopes fail explicitly; no URI is fetched.
 */
export function bundleSchema(source: PayloadSchema, registry: SchemaRegistry, options: SchemaBundleOptions = {}): PayloadSchema {
  const prefix = options.definitionPrefix ?? '';
  if (!/^(?:[a-zA-Z][a-zA-Z0-9]*)?$/.test(prefix)) {
    throw new TypeError('bundleSchema: definitionPrefix must be an identifier.');
  }
  const lookup = (uri: string): PayloadSchema => {
    const schema = Object.hasOwn(registry, uri) ? registry[uri] : undefined;
    if (schema === undefined || schema.$id !== uri) {
      throw new TypeError(`bundleSchema: unregistered schema '${uri}'.`);
    }
    return schema;
  };
  const assertReferenceAnnotations = (value: PayloadSchema, root = false): void => {
    for (const key of Object.keys(value)) {
      if (key === '$id' && !root) {
        throw new TypeError('bundleSchema: nested identifier scopes are unsupported.');
      }
      if (key !== '$ref' && !annotations.has(key)) {
        throw new TypeError(`bundleSchema: '${key}' cannot override a shared schema reference.`);
      }
    }
  };
  const fragment = (uri: string): PayloadSchema => {
    const { $id: _id, $schema: _dialect, ...body } = lookup(uri);
    return body;
  };

  let root = source;
  let rootImport: string | undefined;
  if (typeof source.$ref === 'string' && !source.$ref.startsWith('#')) {
    assertReferenceAnnotations(source, true);
    const { $ref, ...metadata } = source;
    rootImport = $ref;
    root = { ...fragment($ref), ...metadata };
  }
  const definitions: Record<string, SchemaValue> = { ...(isObject(root.definitions) ? root.definitions : {}) };
  const aliases = new Map<string, string>();
  const expanded = new Set<string>();
  const expanding = new Set(rootImport === undefined ? [] : [rootImport]);
  for (const [name, schema] of Object.entries(definitions)) {
    if (isObject(schema) && typeof schema.$ref === 'string' && !schema.$ref.startsWith('#') && !aliases.has(schema.$ref)) {
      aliases.set(schema.$ref, name);
    }
  }

  const ensureDefinition = (uri: string): string => {
    lookup(uri);
    let name = aliases.get(uri);
    if (name === undefined) {
      const parts = new URL(uri).pathname.split('/').filter(Boolean);
      const leaf = parts.at(-1) ?? '';
      name = /^v[0-9]+$/.test(leaf) ? parts.at(-2)! : leaf.replace(/\.json$/, '');
      if (prefix !== '' && name !== undefined) {
        name = prefix + name.replace(/(^|-)([a-zA-Z])/g, (_match, _separator, letter: string): string => letter.toUpperCase());
      }
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) || Object.hasOwn(definitions, name)) {
        throw new TypeError(`bundleSchema: definition name collision for '${uri}'; declare an explicit local alias.`);
      }
      aliases.set(uri, name);
      definitions[name] = { $ref: uri };
    }
    if (expanding.has(uri)) {
      throw new TypeError(`bundleSchema: cyclic shared schema '${uri}'.`);
    }
    const pointer = `#/definitions/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (!expanded.has(uri)) {
      expanding.add(uri);
      definitions[name] = visit(fragment(uri), pointer);
      expanding.delete(uri);
      expanded.add(uri);
    }
    return pointer;
  };

  const visit = (value: SchemaValue, localBase?: string, isRoot = false): SchemaValue => {
    if (Array.isArray(value)) {
      return value.map((child): SchemaValue => visit(child, localBase));
    }
    if (!isObject(value)) {
      return value;
    }
    if (!isRoot && typeof value.$id === 'string') {
      throw new TypeError('bundleSchema: nested identifier scopes are unsupported.');
    }
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#')) {
        assertReferenceAnnotations(value, isRoot);
        return { ...value, $ref: ensureDefinition(value.$ref) };
      }
      if (localBase !== undefined) {
        if (value.$ref !== '#' && !value.$ref.startsWith('#/')) {
          throw new TypeError('bundleSchema: imported local references must be JSON Pointers.');
        }
        return { ...value, $ref: localBase + value.$ref.slice(1) };
      }
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, literalValues.has(key) ? structuredClone(child) : visit(child, localBase)]),
    );
  };

  for (const [name, value] of Object.entries(definitions)) {
    if (isObject(value) && typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
      assertReferenceAnnotations(value);
      ensureDefinition(value.$ref);
      const { $ref: _ref, ...metadata } = value;
      definitions[name] = { ...(definitions[aliases.get(value.$ref)!] as PayloadSchema), ...metadata };
    } else {
      definitions[name] = visit(value);
    }
  }
  const { definitions: _definitions, ...body } = root;
  const result = visit(body, rootImport === undefined ? undefined : '#', true) as PayloadSchema;
  return Object.keys(definitions).length === 0 ? result : { ...result, definitions };
}
