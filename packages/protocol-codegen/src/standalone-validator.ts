/**
 * Build-time generation of CSP-safe JSON Schema validators.
 *
 * Ajv compiles schemas to standalone JavaScript, then esbuild folds Ajv's
 * runtime helpers into one browser-safe block. Generated protocol modules
 * therefore do not depend on Ajv or dynamic code evaluation at runtime.
 *
 * @module
 */

import type { JsonSchema } from './schema-resolver.js';

import addFormats from 'ajv-formats';
import Ajv from 'ajv';
import { build } from 'esbuild';
import { canonicalizeJson } from '@enbox/common';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import standaloneCode from 'ajv/dist/standalone/index.js';

/** A resolved schema and the generated validator property that will expose it. */
export type NamedStandaloneValidator = {
  name: string;
  schema: JsonSchema;
};

type PreparedValidator = NamedStandaloneValidator & {
  schemaKey: string;
  serializedSchema: string;
};

const DRAFT_07_SCHEMA_URIS = new Set([
  'http://json-schema.org/draft-07/schema',
  'http://json-schema.org/draft-07/schema#',
]);

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VALIDATORS_DECLARATION = 'var protocolValidators=';

/**
 * Compile named Draft-07 schemas into a deterministic TypeScript block.
 *
 * The returned block declares a module-scoped `protocolValidators` object.
 * Every Ajv and esbuild dependency is consumed here at generation time; the
 * emitted code has no runtime imports.
 */
export async function generateStandaloneValidators(
  validators: readonly NamedStandaloneValidator[],
): Promise<string> {
  if (validators.length === 0) {
    return '';
  }

  const prepared = prepareValidators(validators);
  const ajv = new Ajv.default({
    allErrors        : false,
    allowUnionTypes  : true,
    code             : { esm: true, optimize: true, source: true },
    coerceTypes      : false,
    removeAdditional : false,
    strictRequired   : false,
    strictSchema     : true,
    strictTuples     : false,
    strictTypes      : true,
    useDefaults      : false,
    validateFormats  : true,
    validateSchema   : true,
  });
  addFormats.default(ajv, { keywords: false, mode: 'full' });

  const canonicalValidators = new Map<string, PreparedValidator>();
  const exportsByName: Record<string, string> = {};
  const aliases: string[] = [];
  for (const validator of prepared) {
    const canonical = canonicalValidators.get(validator.schemaKey);
    if (canonical !== undefined) {
      if (canonical.serializedSchema !== validator.serializedSchema) {
        throw new TypeError(
          `Standalone validators '${canonical.name}' and '${validator.name}' use different schemas ` +
          `with the same $id '${validator.schemaKey}'.`,
        );
      }
      aliases.push(`export const ${validator.name} = ${canonical.name};`);
      continue;
    }

    ajv.addSchema(validator.schema, validator.schemaKey);
    canonicalValidators.set(validator.schemaKey, validator);
    exportsByName[validator.name] = validator.schemaKey;
  }

  let source: string;
  try {
    source = [standaloneCode.default(ajv, exportsByName), ...aliases].join('\n');
  } catch (error: unknown) {
    throw new TypeError(`Failed to compile standalone record validators: ${errorMessage(error)}`, { cause: error });
  }

  return bundleStandaloneSource(source, prepared.map((validator): string => validator.name));
}

function prepareValidators(validators: readonly NamedStandaloneValidator[]): PreparedValidator[] {
  const names = new Set<string>();
  return [...validators]
    .sort((a, b): number => compareCodePoints(a.name, b.name))
    .map((validator): PreparedValidator => {
      assertValidatorName(validator.name);
      if (names.has(validator.name)) {
        throw new TypeError(`Duplicate standalone validator name '${validator.name}'.`);
      }
      names.add(validator.name);

      const schema = canonicalizeJson(validator.schema) as JsonSchema;
      assertSupportedSchema(validator.name, schema);
      const schemaKey = schemaKeyFor(validator.name, schema);

      return {
        name             : validator.name,
        schema,
        schemaKey,
        serializedSchema : JSON.stringify(schema),
      };
    });
}

function assertValidatorName(name: string): void {
  if (!/^validate[$A-Z_a-z][$\w]*$/.test(name)) {
    throw new TypeError(`Standalone validator name '${name}' must be a safe TypeScript identifier.`);
  }
}

function assertSupportedSchema(name: string, schema: JsonSchema): void {
  if (schema.$async === true) {
    throw new TypeError(`Schema for validator '${name}' cannot use $async.`);
  }

  const dialect = schema.$schema;
  if (dialect !== undefined && (typeof dialect !== 'string' || !DRAFT_07_SCHEMA_URIS.has(dialect))) {
    throw new TypeError(
      `Schema for validator '${name}' must use JSON Schema Draft-07; found ${JSON.stringify(dialect)}.`,
    );
  }
}

function schemaKeyFor(name: string, schema: JsonSchema): string {
  const schemaId = schema.$id;
  if (schemaId === undefined) {
    return `urn:enbox:protocol-codegen:${name}`;
  }
  if (typeof schemaId !== 'string' || schemaId === '') {
    throw new TypeError(`Schema for validator '${name}' must have a non-empty string $id when one is declared.`);
  }
  return schemaId;
}

function compareCodePoints(a: string, b: string): number {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}

async function bundleStandaloneSource(source: string, validatorNames: readonly string[]): Promise<string> {
  const result = await build({
    bundle        : true,
    format        : 'iife',
    globalName    : 'protocolValidators',
    legalComments : 'none',
    metafile      : true,
    minify        : true,
    platform      : 'browser',
    stdin         : {
      contents   : source,
      loader     : 'js',
      resolveDir : MODULE_DIRECTORY,
      sourcefile : 'standalone-record-validators.js',
    },
    target : 'es2022',
    write  : false,
  });

  const runtimeImports = Object.values(result.metafile.outputs)
    .flatMap((output): readonly unknown[] => output.imports);
  if (runtimeImports.length > 0) {
    throw new TypeError('Standalone record validator bundle unexpectedly contains runtime imports.');
  }

  if (result.outputFiles.length !== 1) {
    throw new TypeError(`Expected one standalone record validator output; received ${result.outputFiles.length}.`);
  }

  const bundled = result.outputFiles[0].text.trim().replace(/^"use strict";/, '');
  if (!bundled.startsWith(PROTOCOL_VALIDATORS_DECLARATION)) {
    throw new TypeError('Standalone record validator bundle has an unexpected declaration shape.');
  }

  const initializer = bundled.slice(PROTOCOL_VALIDATORS_DECLARATION.length).replace(/;$/, '');
  const properties = validatorNames
    .map((name): string => `readonly ${name}: RecordValidator`)
    .join(';');

  return [
    '/* eslint-disable */',
    '// @ts-expect-error -- Ajv emits minified JavaScript; the explicit type below is the generated contract.',
    `const protocolValidators: {${properties}} = ${initializer};`,
    '/* eslint-enable */',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
