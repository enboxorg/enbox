/**
 * Schema resolution for protocol type definitions.
 *
 * Resolves schema URIs to local JSON Schema objects using a convention-based
 * lookup strategy:
 *
 * 1. **Local file (by type name)**: `<schemasDir>/<typeName>.json`
 * 2. **Local file (by URI path)**: `<schemasDir>/<last-two-segments>.json`
 *
 * Network resolution is intentionally unsupported so identical repository
 * inputs always produce identical output.
 *
 * @module
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed JSON Schema object. */
export type JsonSchema = Record<string, unknown>;

/** Result of resolving a single schema URI. */
export type SchemaResolution = {
  /** The type name from the protocol definition. */
  typeName: string;
  /** The schema URI from the protocol definition. */
  schemaUri: string;
  /** The resolved JSON Schema, or `undefined` if unresolvable. */
  schema?: JsonSchema;
  /** How the schema was resolved. */
  source: 'local-type-name' | 'local-uri-path' | 'unresolved';
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a schema URI to a JSON Schema object.
 *
 * @param typeName   - The protocol type name (e.g. `'product'`).
 * @param schemaUri  - The schema URI from the protocol definition.
 * @param schemasDir - Directory to search for local `.json` schema files.
 * @returns A resolution result with the schema and its source.
 */
export async function resolveSchema(
  typeName: string,
  schemaUri: string,
  schemasDir: string,
): Promise<SchemaResolution> {
  const schemasRoot = await realpath(schemasDir);

  // Strategy 1: local file by type name
  const byTypeName = await readLocalSchema(schemasRoot, `${typeName}.json`);
  if (byTypeName !== undefined) {
    const schema = byTypeName;
    return { typeName, schemaUri, schema, source: 'local-type-name' };
  }

  // Strategy 2: local file by URI path (last two segments)
  const uriPath = extractUriPath(schemaUri);
  if (uriPath !== undefined) {
    const byUriPath = await readLocalSchema(schemasRoot, `${uriPath}.json`);
    if (byUriPath !== undefined) {
      const schema = byUriPath;
      return { typeName, schemaUri, schema, source: 'local-uri-path' };
    }
  }

  return { typeName, schemaUri, source: 'unresolved' };
}

/**
 * Resolve all schema URIs from a protocol's `types` map.
 *
 * Types without a `schema` property (binary-only types) are skipped.
 *
 * @param types      - The `types` map from a `ProtocolDefinition`.
 * @param schemasDir - Directory to search for local `.json` schema files.
 * @returns A map of type name → resolution result.
 */
export async function resolveAllSchemas(
  types: Record<string, { schema?: string }>,
  schemasDir: string,
): Promise<Map<string, SchemaResolution>> {
  const results = new Map<string, SchemaResolution>();

  const entries = Object.entries(types).filter(
    ([, type]) => type.schema !== undefined,
  );

  const resolved = await Promise.all(
    entries.map(([name, type]) => resolveSchema(name, type.schema!, schemasDir)),
  );

  for (const result of resolved) {
    results.set(result.typeName, result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file.
 */
async function readLocalSchema(schemasRoot: string, relativePath: string): Promise<JsonSchema | undefined> {
  const candidatePath = resolve(schemasRoot, relativePath);
  assertPathWithinSchemasRoot(candidatePath, schemasRoot);

  let schemaPath: string;
  try {
    schemaPath = await realpath(candidatePath);
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  assertPathWithinSchemasRoot(schemaPath, schemasRoot);
  const content = await readFile(schemaPath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(
      `JSON Schema file '${schemaPath}' must contain a non-null object (found ${describeJsonValue(parsed)}).`,
    );
  }

  return parsed as JsonSchema;
}

function describeJsonValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function assertPathWithinSchemasRoot(path: string, schemasRoot: string): void {
  const relativePath = relative(schemasRoot, path);
  const escapesRoot = relativePath === '..' || relativePath.startsWith(`..${sep}`);
  if (!escapesRoot && !isAbsolute(relativePath)) {
    return;
  }

  throw new TypeError(`Schema path must be within the schemas directory: ${path}`);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Extract a relative path from a schema URI for local file lookup.
 *
 * For `https://example.com/schemas/inventory/product`, returns
 * `inventory/product`.
 *
 * Returns `undefined` if the URI has fewer than 2 path segments after
 * the `/schemas/` prefix or has no recognizable path structure.
 */
function extractUriPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    const segments = url.pathname.split('/').filter(Boolean);

    // Look for a "schemas" segment and take everything after it
    const schemasIndex = segments.indexOf('schemas');
    if (schemasIndex !== -1 && schemasIndex < segments.length - 1) {
      return segments.slice(schemasIndex + 1).join('/');
    }

    // Fallback: take the last two segments
    if (segments.length >= 2) {
      return segments.slice(-2).join('/');
    }

    return undefined;
  } catch {
    return undefined;
  }
}
