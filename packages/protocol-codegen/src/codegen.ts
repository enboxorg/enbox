/**
 * Core code generation engine.
 *
 * Takes a protocol definition (as a plain object) and a schemas directory,
 * resolves local JSON Schemas for reachable JSON payload types, generates TypeScript interfaces
 * via `json-schema-to-typescript`, and emits a complete module with:
 *
 * - Individual data-shape types for each protocol type
 * - Runtime codecs mapping type names to their data shapes
 * - The complete protocol definition
 * - A `defineProtocol()` call wiring everything together
 *
 * @module
 */

import type { JSONSchema4 } from 'json-schema';

import type { JsonSchema, SchemaResolution } from './schema-resolver.js';

import { compile } from 'json-schema-to-typescript';
import { resolveAllSchemas } from './schema-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Protocol definition shape accepted by the generator. */
export type ProtocolDefinitionInput = {
  protocol: string;
  types: Record<string, ProtocolTypeInput>;
  structure: Record<string, unknown>;
  published?: boolean;
  [key: string]: unknown;
};

/** Minimal protocol type shape, while preserving additional DWN directives. */
export type ProtocolTypeInput = {
  schema?: string;
  dataFormats?: readonly string[];
  [key: string]: unknown;
};

/** Options for the code generation. */
export type CodegenOptions = {
  /** Permit reachable JSON types without a local schema to fall back to `unknown`. */
  allowUnresolvedJsonSchemas?: boolean;

  /** Directory containing `.json` schema files. */
  schemasDir: string;

  /** Base name for the generated protocol exports (e.g. `'Inventory'`). */
  protocolName: string;

  /** Banner comment at the top of the file. Set to `''` to suppress. */
  bannerComment?: string;
};

/** Result of the code generation. */
export type CodegenResult = {
  /** The generated TypeScript module source code. */
  code: string;

  /** Schema resolution details for each type. */
  resolutions: Map<string, SchemaResolution>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete typed protocol module from a definition and JSON Schemas.
 *
 * @param definition - The protocol definition object.
 * @param options    - Code generation options.
 * @returns The generated source code and resolution metadata.
 */
export async function generateProtocolModule(
  definition: ProtocolDefinitionInput,
  options: CodegenOptions,
): Promise<CodegenResult> {
  const { allowUnresolvedJsonSchemas = false, schemasDir, protocolName } = options;
  const banner = options.bannerComment ?? DEFAULT_BANNER;

  const reachableTypeNames = collectReachableTypeNames(definition.structure);
  const unknownTypeNames = [...reachableTypeNames]
    .filter((typeName: string): boolean => definition.types[typeName] === undefined);
  if (unknownTypeNames.length > 0) {
    unknownTypeNames.sort((a, b) => a.localeCompare(b));
    throw new TypeError(
      `Protocol structure references types missing from the definition: ` +
      `${unknownTypeNames.join(', ')}`,
    );
  }

  assertValidGeneratedNames(definition.types, protocolName);

  // Only JSON payload schemas participate in code generation. A schema URI on
  // a binary or mixed-format type is an opaque DWN descriptor constraint, not
  // necessarily a JSON Schema document.
  const jsonSchemaTypes = Object.fromEntries(
    Object.entries(definition.types)
      .filter(([typeName]): boolean => reachableTypeNames.has(typeName))
      .filter(([, type]): boolean => isSingleJsonType(type))
      .filter(([, type]): boolean => type.schema !== undefined),
  );
  const resolutions = await resolveAllSchemas(jsonSchemaTypes, schemasDir);
  assertReachableJsonSchemas({
    allowUnresolvedJsonSchemas,
    definition,
    reachableTypeNames,
    resolutions,
  });

  // Generate TypeScript interfaces from resolved schemas
  const typeBlocks: string[] = [];

  for (const [typeName, type] of Object.entries(definition.types)) {
    const resolution = resolutions.get(typeName);
    const tsTypeName = pascalCase(typeName) + 'Data';

    const formats = uniqueDataFormats(type);
    if (formats.length === 1 && isJsonFormat(formats[0]) && resolution?.schema !== undefined) {
      // Generate from JSON Schema
      const tsCode = await compileSchema(resolution.schema, tsTypeName);
      typeBlocks.push(tsCode);
    } else {
      typeBlocks.push(generateDataType(typeName, tsTypeName, type));
    }
  }

  const codecEntries = Object.entries(definition.types)
    .filter(([typeName]): boolean => reachableTypeNames.has(typeName))
    .map(([typeName, type]): readonly [string, string] => [
      typeName,
      generateCodecExpression(typeName, pascalCase(typeName) + 'Data', type),
    ]);

  const sections = [
    ...(banner === '' ? [] : [banner]),
    `import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';\n`,
    `import { defineProtocol, recordCodecs } from '@enbox/api';\n`,
    '// ---------------------------------------------------------------------------',
    '// Data types',
    '// ---------------------------------------------------------------------------\n',
    typeBlocks.join('\n'),
    '// ---------------------------------------------------------------------------',
    '// Protocol definition',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Definition = ${formatTypeScriptValue(definition)} as const satisfies ProtocolDefinition;\n`,
    '// ---------------------------------------------------------------------------',
    '// Runtime codecs',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Codecs = ${formatObjectEntries(codecEntries)} as const;\n`,
    '// ---------------------------------------------------------------------------',
    '// Typed protocol',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Protocol = defineProtocol(${protocolName}Definition, ${protocolName}Codecs);`,
  ];

  const code = sections.join('\n') + '\n';

  return { code, resolutions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_BANNER = [
  '/**',
  ' * Auto-generated by @enbox/protocol-codegen.',
  ' * Do not edit manually.',
  ' */',
  '',
].join('\n');

/**
 * Compile a JSON Schema to a TypeScript interface string.
 */
async function compileSchema(schema: JsonSchema, typeName: string): Promise<string> {
  // json-schema-to-typescript gives a schema title precedence over the
  // requested root name. Pin it to the generated identifier so a schema title
  // cannot silently make the emitted codec refer to a missing type.
  const normalizedSchema = { ...schema, title: typeName };
  const tsCode = await compile(normalizedSchema as JSONSchema4, typeName, {
    $refOptions: {
      dereference : { excludedPathMatcher: shouldExcludeSchemaDereference },
      resolve     : { external: false, file: false, http: false },
    },
    bannerComment         : '',
    additionalProperties  : false,
    format                : false,
    unknownAny            : true,
    strictIndexSignatures : false,
    style                 : {
      bracketSpacing : false,
      printWidth     : 120,
      semi           : true,
      singleQuote    : true,
      tabWidth       : 2,
      trailingComma  : 'all',
      useTabs        : false,
    },
  });

  return tsCode.trim() + '\n';
}

/** Generates a data-shape type when no local JSON Schema was resolved. */
function generateDataType(typeName: string, tsTypeName: string, type: ProtocolTypeInput): string {
  const formats = uniqueDataFormats(type);
  if (formats.length === 1 && isJsonFormat(formats[0])) {
    return `/** Data shape for the \`${typeName}\` type. Schema was not resolved. */\nexport type ${tsTypeName} = unknown;\n`;
  }

  if (formats.length === 1 && isTextFormat(formats[0])) {
    return `/** Data shape for the \`${typeName}\` type (text). */\nexport type ${tsTypeName} = string;\n`;
  }

  if (formats.length === 1) {
    return `/** Data shape for the \`${typeName}\` type (bytes). */\nexport type ${tsTypeName} = Uint8Array;\n`;
  }

  if (formats.length > 1) {
    return `/** Data shape for the \`${typeName}\` type (variable MIME). */\nexport type ${tsTypeName} = Blob;\n`;
  }

  return `/** Data shape for the \`${typeName}\` type. No data representation was declared. */\nexport type ${tsTypeName} = unknown;\n`;
}

/** Generates the built-in runtime codec for one protocol type. */
function generateCodecExpression(typeName: string, tsTypeName: string, type: ProtocolTypeInput): string {
  const formats = uniqueDataFormats(type);
  if (formats.length === 1 && isJsonFormat(formats[0])) {
    return callCodec(`json<${tsTypeName}>`, formats[0], 'application/json');
  }

  if (formats.length === 1 && isTextFormat(formats[0])) {
    return callCodec('text', formats[0], 'text/plain');
  }

  if (formats.length === 1) {
    return callCodec('bytes', formats[0], 'application/octet-stream');
  }

  if (formats.length > 1) {
    return 'recordCodecs.blob()';
  }

  throw new TypeError(
    `Cannot infer a record codec for protocol type '${typeName}': declare at least one data format.`,
  );
}

/** Emits a codec call, omitting its argument when the selected MIME type is the built-in default. */
function callCodec(name: string, dataFormat: string, defaultDataFormat: string): string {
  return dataFormat === defaultDataFormat
    ? `recordCodecs.${name}()`
    : `recordCodecs.${name}(${quoteString(dataFormat)})`;
}

function uniqueDataFormats(type: ProtocolTypeInput): string[] {
  return [...new Set(type.dataFormats ?? [])];
}

function isSingleJsonType(type: ProtocolTypeInput): boolean {
  const formats = uniqueDataFormats(type);
  return formats.length === 1 && isJsonFormat(formats[0]);
}

function isJsonFormat(dataFormat: string): boolean {
  const essence = dataFormat.split(';', 1)[0].trim().toLowerCase();
  return essence === 'application/json'
    || /^application\/[a-z0-9][a-z0-9!#$&^_.+-]*\+json$/.test(essence);
}

function isTextFormat(dataFormat: string): boolean {
  return dataFormat.split(';', 1)[0].trim().toLowerCase().startsWith('text/');
}

type ReachableJsonSchemaValidation = {
  allowUnresolvedJsonSchemas: boolean;
  definition: ProtocolDefinitionInput;
  reachableTypeNames: ReadonlySet<string>;
  resolutions: ReadonlyMap<string, SchemaResolution>;
};

/** Enforces the fail-closed contract only for JSON types used by the structure. */
function assertReachableJsonSchemas(options: ReachableJsonSchemaValidation): void {
  const failures: string[] = [];
  const reachableTypeNames = [...options.reachableTypeNames].sort((a, b): number => a.localeCompare(b));

  for (const typeName of reachableTypeNames) {
    const type = options.definition.types[typeName];
    if (!isSingleJsonType(type)) {
      continue;
    }

    const schemaUri = type.schema;
    if (schemaUri === undefined || schemaUri.trim() === '') {
      if (!options.allowUnresolvedJsonSchemas) {
        failures.push(`type '${typeName}' must declare a schema URI`);
      }
      continue;
    }

    const resolution = options.resolutions.get(typeName);
    if (resolution?.schema === undefined) {
      if (!options.allowUnresolvedJsonSchemas) {
        failures.push(`type '${typeName}' has no local schema for '${schemaUri}'`);
      }
      continue;
    }

    const schemaId = resolution.schema.$id;
    if (typeof schemaId !== 'string') {
      failures.push(
        `type '${typeName}' schema must declare a string $id equal to '${schemaUri}' ` +
        `(found ${formatSchemaValue(schemaId)})`,
      );
      continue;
    }

    if (schemaId !== schemaUri) {
      failures.push(`type '${typeName}' schema $id must equal '${schemaUri}' (found ${JSON.stringify(schemaId)})`);
      continue;
    }

    for (const schemaRef of collectUnsupportedSchemaRefs(resolution.schema)) {
      failures.push(
        `type '${typeName}' schema $ref at '${schemaRef.path}' must be a local fragment beginning with '#' ` +
        `(found ${formatSchemaValue(schemaRef.value)})`,
      );
    }
  }

  if (failures.length > 0) {
    throw new TypeError(`Protocol code generation failed:\n- ${failures.join('\n- ')}`);
  }
}

function formatSchemaValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

type UnsupportedSchemaRef = { path: string; value: unknown };

const SINGLE_SUBSCHEMA_KEYWORDS: readonly string[] = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

const SUBSCHEMA_ARRAY_KEYWORDS: readonly string[] = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_MAP_KEYWORDS: readonly string[] = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

type SchemaTraversalState =
  | 'dependencies-map'
  | 'dependency-entry'
  | 'items'
  | 'schema'
  | 'schema-array'
  | 'schema-map';

/**
 * Ref Parser follows every object-shaped `$ref`, including literal values in
 * `const`, `default`, `enum`, and `examples`. Limit its crawl to paths that can
 * contain JSON Schemas while retaining real local-fragment dereferencing.
 */
function shouldExcludeSchemaDereference(path: string): boolean {
  const tokens = parseRefParserPath(path);
  if (tokens === undefined) {
    return true;
  }

  let state: SchemaTraversalState = 'schema';
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];

    if (state === 'schema') {
      if (SINGLE_SUBSCHEMA_KEYWORDS.includes(token)) {
        index++;
        continue;
      }
      if (SUBSCHEMA_ARRAY_KEYWORDS.includes(token)) {
        state = 'schema-array';
        index++;
        continue;
      }
      if (SUBSCHEMA_MAP_KEYWORDS.includes(token)) {
        state = 'schema-map';
        index++;
        continue;
      }
      if (token === 'items') {
        state = 'items';
        index++;
        continue;
      }
      if (token === 'dependencies') {
        state = 'dependencies-map';
        index++;
        continue;
      }
      return true;
    }

    if (state === 'schema-map') {
      state = 'schema';
      index++;
      continue;
    }

    if (state === 'schema-array') {
      if (!isArrayIndex(token)) {
        return true;
      }
      state = 'schema';
      index++;
      continue;
    }

    if (state === 'items') {
      if (isArrayIndex(token)) {
        state = 'schema';
        index++;
      } else {
        // `items` can itself be a schema, so process this token again as a
        // keyword within that schema.
        state = 'schema';
      }
      continue;
    }

    if (state === 'dependencies-map') {
      state = 'dependency-entry';
      index++;
      continue;
    }

    // A legacy `dependencies` entry is either a schema or an array of literal
    // property names. Re-process a child token as a schema keyword; array
    // indices will consequently be excluded.
    state = 'schema';
  }

  return false;
}

function parseRefParserPath(path: string): string[] | undefined {
  if (path === '#') {
    return [];
  }
  if (!path.startsWith('#/')) {
    return undefined;
  }

  try {
    return path.slice(2).split('/').map((token: string): string => (
      decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~')
    ));
  } catch {
    return undefined;
  }
}

function isArrayIndex(token: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(token);
}

/** Finds external refs only where `$ref` is a JSON Schema keyword, not literal instance data or map keys. */
function collectUnsupportedSchemaRefs(value: unknown, path = '#'): UnsupportedSchemaRef[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const schema = value as Record<string, unknown>;
  const failures: UnsupportedSchemaRef[] = [];
  if (Object.hasOwn(schema, '$ref')
    && (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#'))) {
    failures.push({ path: `${path}/$ref`, value: schema.$ref });
  }

  for (const keyword of SINGLE_SUBSCHEMA_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      failures.push(...collectUnsupportedSchemaRefs(schema[keyword], `${path}/${keyword}`));
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const [index, child] of items.entries()) {
      failures.push(...collectUnsupportedSchemaRefs(child, `${path}/items/${index}`));
    }
  } else if (items !== undefined) {
    failures.push(...collectUnsupportedSchemaRefs(items, `${path}/items`));
  }

  for (const keyword of SUBSCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) {
      continue;
    }
    for (const [index, child] of children.entries()) {
      failures.push(...collectUnsupportedSchemaRefs(child, `${path}/${keyword}/${index}`));
    }
  }

  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword];
    if (children === null || typeof children !== 'object' || Array.isArray(children)) {
      continue;
    }
    for (const [key, child] of Object.entries(children)) {
      failures.push(...collectUnsupportedSchemaRefs(
        child,
        `${path}/${keyword}/${escapeJsonPointerSegment(key)}`,
      ));
    }
  }

  const dependencies = schema.dependencies;
  if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const [key, child] of Object.entries(dependencies)) {
      if (!Array.isArray(child)) {
        failures.push(...collectUnsupportedSchemaRefs(
          child,
          `${path}/dependencies/${escapeJsonPointerSegment(key)}`,
        ));
      }
    }
  }

  return failures;
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Ensures every symbol emitted by the generator is a stable TypeScript identifier. */
function assertValidGeneratedNames(types: Record<string, ProtocolTypeInput>, protocolName: string): void {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(protocolName)) {
    throw new TypeError(
      `Protocol name '${protocolName}' must be a PascalCase TypeScript identifier containing only letters and numbers.`,
    );
  }

  const typeNamesByIdentifier = new Map<string, string[]>();
  for (const typeName of Object.keys(types)) {
    const identifier = `${pascalCase(typeName)}Data`;
    if (!/^[$A-Z_a-z][$\w]*$/.test(identifier)) {
      throw new TypeError(`Protocol type '${typeName}' cannot be converted to a valid TypeScript identifier.`);
    }

    const collidingTypeNames = typeNamesByIdentifier.get(identifier) ?? [];
    collidingTypeNames.push(typeName);
    typeNamesByIdentifier.set(identifier, collidingTypeNames);
  }

  for (const [identifier, typeNames] of typeNamesByIdentifier) {
    if (typeNames.length > 1) {
      throw new TypeError(
        `Protocol types ${typeNames.map((typeName: string): string => `'${typeName}'`).join(', ')} ` +
        `all generate the identifier '${identifier}'.`,
      );
    }
  }
}

/** Collects the local type names reachable through the protocol structure. */
function collectReachableTypeNames(structure: Record<string, unknown>, prefix = ''): Set<string> {
  const typeNames = new Set<string>();

  for (const [key, child] of Object.entries(structure)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = prefix === '' ? key : `${prefix}/${key}`;
    if (isPlainObject(child)) {
      if (typeof child.$ref === 'string') {
        throw new TypeError(
          `Cannot generate a typed codec for $ref path '${path}'; ` +
          'use a hand-written protocol declaration until composition-aware codecs are supported.',
        );
      }
      for (const nestedTypeName of collectReachableTypeNames(child, path)) {
        typeNames.add(nestedTypeName);
      }
    }
    typeNames.add(key);
  }

  return typeNames;
}

/** Formats raw codec expressions as a readable object literal. */
function formatObjectEntries(entries: readonly (readonly [string, string])[], indentation = 0): string {
  if (entries.length === 0) {
    return '{}';
  }

  const indent = ' '.repeat(indentation);
  const lines = formatPropertyEntries(entries, indentation + 2);

  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** Formats a JSON-compatible value as a readable TypeScript literal. */
function formatTypeScriptValue(value: unknown, indentation = 0): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return quoteString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return formatArray(value, indentation);
  }

  if (isPlainObject(value)) {
    return formatValueObject(value, indentation);
  }

  throw new TypeError('Protocol definitions must contain only JSON-compatible values.');
}

function formatArray(values: unknown[], indentation: number): string {
  if (values.length === 0) {
    return '[]';
  }

  if (values.every((value: unknown): boolean => (
    value === null || ['boolean', 'number', 'string'].includes(typeof value)
  ))) {
    return `[${values.map((value: unknown): string => formatTypeScriptValue(value)).join(', ')}]`;
  }

  const indent = ' '.repeat(indentation);
  const childIndent = ' '.repeat(indentation + 2);
  const lines = values.map(
    (value: unknown): string => `${childIndent}${formatTypeScriptValue(value, indentation + 2)},`,
  );
  return `[\n${lines.join('\n')}\n${indent}]`;
}

function formatValueObject(value: Record<string, unknown>, indentation: number): string {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }

  const indent = ' '.repeat(indentation);
  const formattedEntries = entries.map(([key, child]): readonly [string, string] => [
    key,
    formatTypeScriptValue(child, indentation + 2),
  ]);
  const lines = formatPropertyEntries(formattedEntries, indentation + 2);

  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** Mirrors the repository's aligned-key style, whose groups end after a multiline value. */
function formatPropertyEntries(entries: readonly (readonly [string, string])[], indentation: number): string[] {
  const lines: string[] = [];
  let group: (readonly [string, string])[] = [];

  for (const entry of entries) {
    group.push(entry);
    if (entry[1].includes('\n')) {
      lines.push(...formatPropertyGroup(group, indentation));
      group = [];
    }
  }

  lines.push(...formatPropertyGroup(group, indentation));
  return lines;
}

function formatPropertyGroup(entries: readonly (readonly [string, string])[], indentation: number): string[] {
  if (entries.length === 0) {
    return [];
  }

  const indent = ' '.repeat(indentation);
  const propertyNames = entries.map(([key]): string => formatPropertyName(key));
  const maxPropertyLength = Math.max(...propertyNames.map((propertyName: string): number => propertyName.length));
  return entries.map(([_, value], index): string => {
    const propertyName = propertyNames[index];
    const separator = entries.length === 1
      ? ': '
      : `${' '.repeat(maxPropertyLength - propertyName.length)} : `;
    return `${indent}${propertyName}${separator}${value},`;
  });
}

function formatPropertyName(propertyName: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(propertyName) ? propertyName : quoteString(propertyName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quoteString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Convert a string to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(\w)/, (_, c: string) => c.toUpperCase());
}
