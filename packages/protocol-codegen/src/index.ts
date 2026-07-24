/**
 * `@enbox/protocol-codegen` — generate TypeScript types from DWN protocol
 * definitions and JSON Schema files.
 *
 * This package provides both a CLI and a programmatic API for generating
 * typed data shapes, runtime codecs, and protocol wiring from protocol
 * definitions paired with JSON Schema files.
 *
 * @example
 * ```ts
 * import { generateProtocolModule } from '@enbox/protocol-codegen';
 *
 * const definition = {
 *   protocol: 'https://example.com/protocols/inventory',
 *   types: { product: { schema: 'https://example.com/schemas/product', dataFormats: ['application/json'] } },
 *   structure: { product: { $actions: [{ who: 'anyone', can: ['read'] }] } },
 * };
 *
 * const { code, resolutions } = await generateProtocolModule(definition, {
 *   schemasDir: './schemas',
 *   protocolName: 'Inventory',
 * });
 *
 * console.log(code);
 * ```
 *
 * @packageDocumentation
 */

export { generateProtocolModule } from './codegen.js';
export type { CodegenOptions, CodegenResult, ProtocolDefinitionInput, ProtocolTypeInput } from './codegen.js';
export { resolveAllSchemas, resolveSchema } from './schema-resolver.js';
export type { JsonSchema, SchemaResolution } from './schema-resolver.js';
