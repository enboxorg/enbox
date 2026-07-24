/**
 * Core code generation engine.
 *
 * Takes a protocol definition (as a plain object) and a schemas directory,
 * resolves JSON Schemas for each type, generates TypeScript interfaces
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
  /** Directory containing `.json` schema files. */
  schemasDir: string;

  /** Base name for the generated protocol exports (e.g. `'SocialGraph'`). */
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
  const { schemasDir, protocolName } = options;
  const banner = options.bannerComment ?? DEFAULT_BANNER;

  // Resolve schemas for all typed entries
  const resolutions = await resolveAllSchemas(definition.types, schemasDir);
  const reachableTypeNames = collectReachableTypeNames(definition.structure);
  const unknownTypeNames = [...reachableTypeNames]
    .filter((typeName: string): boolean => definition.types[typeName] === undefined);
  if (unknownTypeNames.length > 0) {
    throw new TypeError(
      `Protocol structure references types missing from the definition: ${unknownTypeNames.sort().join(', ')}`,
    );
  }

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

  // Build the full output
  const sections: string[] = [];

  if (banner !== '') {
    sections.push(banner);
  }

  sections.push(
    `import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';\n`,
    `import { defineProtocol, recordCodecs } from '@enbox/api';\n`,
  );

  // Type blocks
  sections.push(
    '// ---------------------------------------------------------------------------',
    '// Data types',
    '// ---------------------------------------------------------------------------\n',
    typeBlocks.join('\n'),
  );

  // Protocol definition
  sections.push(
    '// ---------------------------------------------------------------------------',
    '// Protocol definition',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Definition = ${formatTypeScriptValue(definition)} as const satisfies ProtocolDefinition;\n`,
  );

  // Runtime codecs
  sections.push(
    '// ---------------------------------------------------------------------------',
    '// Runtime codecs',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Codecs = ${formatObjectEntries(codecEntries)} as const;\n`,
  );

  // Typed protocol
  sections.push(
    '// ---------------------------------------------------------------------------',
    '// Typed protocol',
    '// ---------------------------------------------------------------------------\n',
    `export const ${protocolName}Protocol = defineProtocol(${protocolName}Definition, ${protocolName}Codecs);`,
  );

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
  const tsCode = await compile(schema as JSONSchema4, typeName, {
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

function isJsonFormat(dataFormat: string): boolean {
  const essence = dataFormat.split(';', 1)[0].trim().toLowerCase();
  return essence.endsWith('/json') || essence.endsWith('+json');
}

function isTextFormat(dataFormat: string): boolean {
  return dataFormat.split(';', 1)[0].trim().toLowerCase().startsWith('text/');
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
