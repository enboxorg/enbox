/**
 * `@enbox/protocol-codegen` — generate TypeScript types from DWN protocol
 * definitions and JSON Schema files.
 *
 * This package provides both a CLI and a programmatic API for generating
 * typed data shapes, schema maps, and protocol wiring from protocol
 * definitions paired with JSON Schema files.
 *
 * @example
 * ```ts
 * import { generateTypes } from '@enbox/protocol-codegen';
 *
 * const definition = {
 *   protocol: 'https://example.com/protocols/social',
 *   types: { friend: { schema: 'https://example.com/schemas/friend', dataFormats: ['application/json'] } },
 *   structure: { friend: { $actions: [{ who: 'anyone', can: ['create'] }] } },
 * };
 *
 * const { code, resolutions } = await generateTypes(definition, {
 *   schemasDir: './schemas',
 *   protocolName: 'Social',
 * });
 *
 * console.log(code);
 * ```
 *
 * @packageDocumentation
 */

export { generateTypes } from './codegen.js';
export type { CodegenOptions, CodegenResult, ProtocolDefinitionInput } from './codegen.js';
export { resolveAllSchemas, resolveSchema } from './schema-resolver.js';
export type { JsonSchema, SchemaResolution } from './schema-resolver.js';
