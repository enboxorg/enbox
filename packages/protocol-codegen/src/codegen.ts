/**
 * Core code generation engine.
 *
 * Takes a protocol definition (as a plain object) and a schemas directory,
 * resolves JSON Schemas for each type, generates TypeScript interfaces
 * via `json-schema-to-typescript`, and emits a complete module with:
 *
 * - Individual data-shape types for each protocol type
 * - A `SchemaMap` mapping type names to their data shapes
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

/** Minimal protocol definition shape — only the fields codegen needs. */
export type ProtocolDefinitionInput = {
  protocol: string;
  types: Record<string, { schema?: string; dataFormats?: readonly string[] }>;
  structure: Record<string, unknown>;
  published?: boolean;
};

/** Options for the code generation. */
export type CodegenOptions = {
  /** Directory containing `.json` schema files. */
  schemasDir: string;

  /** Name for the generated protocol constant (e.g. `'SocialGraph'`). */
  protocolName: string;

  /** Whether to emit the protocol definition inline. Defaults to `false`. */
  emitDefinition?: boolean;

  /** Banner comment at the top of the file. Set to `''` to suppress. */
  bannerComment?: string;
};

/** Result of the code generation. */
export type CodegenResult = {
  /** The generated TypeScript source code. */
  code: string;

  /** Schema resolution details for each type. */
  resolutions: Map<string, SchemaResolution>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate TypeScript types from a protocol definition and JSON Schemas.
 *
 * @param definition - The protocol definition object.
 * @param options    - Code generation options.
 * @returns The generated source code and resolution metadata.
 */
export async function generateTypes(
  definition: ProtocolDefinitionInput,
  options: CodegenOptions,
): Promise<CodegenResult> {
  const { schemasDir, protocolName } = options;
  const banner = options.bannerComment ?? DEFAULT_BANNER;

  // Resolve schemas for all typed entries
  const resolutions = await resolveAllSchemas(definition.types, schemasDir);

  // Generate TypeScript interfaces from resolved schemas
  const typeBlocks: string[] = [];
  const typeNames = new Map<string, string>(); // typeName -> generated TS type name

  for (const [typeName, type] of Object.entries(definition.types)) {
    const resolution = resolutions.get(typeName);
    const tsTypeName = pascalCase(typeName) + 'Data';
    typeNames.set(typeName, tsTypeName);

    if (resolution?.schema !== undefined) {
      // Generate from JSON Schema
      const tsCode = await compileSchema(resolution.schema, tsTypeName);
      typeBlocks.push(tsCode);
    } else if (isBinaryType(type)) {
      // Binary-only type (no schema, non-JSON data formats)
      typeBlocks.push(`/** Data shape for the \`${typeName}\` type (binary). */\nexport type ${tsTypeName} = Blob;\n`);
    } else {
      // Unresolved schema — emit unknown
      typeBlocks.push(
        `/** Data shape for the \`${typeName}\` type. Schema was not resolved. */\nexport type ${tsTypeName} = unknown;\n`,
      );
    }
  }

  // Build SchemaMap
  const schemaMapName = `${protocolName}SchemaMap`;
  const schemaMapEntries = Object.keys(definition.types)
    .map((typeName) => {
      const tsTypeName = typeNames.get(typeName)!;
      return `  ${typeName}: ${tsTypeName};`;
    })
    .join('\n');

  const schemaMapBlock = [
    `/** Maps protocol type names to their TypeScript data shapes. */`,
    `export type ${schemaMapName} = {`,
    schemaMapEntries,
    `};`,
  ].join('\n');

  // Build the full output
  const sections: string[] = [];

  if (banner !== '') {
    sections.push(banner);
  }

  // Import for defineProtocol (unless emitting definition inline)
  if (options.emitDefinition) {
    sections.push(
      `import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';\n`,
      `import { defineProtocol } from '@enbox/api';`,
    );
  }

  // Type blocks
  sections.push('// ---------------------------------------------------------------------------');
  sections.push('// Data types');
  sections.push('// ---------------------------------------------------------------------------\n');
  sections.push(typeBlocks.join('\n'));

  // Schema map
  sections.push('// ---------------------------------------------------------------------------');
  sections.push('// Schema map');
  sections.push('// ---------------------------------------------------------------------------\n');
  sections.push(schemaMapBlock);

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

/**
 * Checks if a protocol type is binary-only (no schema, non-JSON data formats).
 */
function isBinaryType(type: { schema?: string; dataFormats?: readonly string[] }): boolean {
  if (type.schema !== undefined) { return false; }
  if (type.dataFormats === undefined || type.dataFormats.length === 0) { return false; }
  return type.dataFormats.every((fmt) => !fmt.includes('json'));
}

/**
 * Convert a string to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(\w)/, (_, c: string) => c.toUpperCase());
}
