/**
 * `@enbox/module-codegen` — generate TypeScript types from DWN module
 * definitions and JSON Schema files.
 *
 * This package provides both a CLI and a programmatic API for generating
 * typed data shapes, runtime codecs, and module wiring from module
 * definitions paired with JSON Schema files.
 *
 * @example
 * ```ts
 * import { generateModuleModule } from '@enbox/module-codegen';
 *
 * const definition = {
 *   module: 'https://example.com/modules/inventory',
 *   types: { product: { schema: 'https://example.com/schemas/product', dataFormats: ['application/json'] } },
 *   structure: { product: { $actions: [{ who: 'anyone', can: ['read'] }] } },
 * };
 *
 * const { code, resolutions } = await generateModuleModule(definition, {
 *   schemasDir: './schemas',
 *   moduleName: 'Inventory',
 * });
 *
 * console.log(code);
 * ```
 *
 * @packageDocumentation
 */

export { generateModuleModule } from './codegen.js';
export type {
  CodegenOptions,
  CodegenResult,
  CodegenTarget,
  ModuleDefinitionInput,
  ModuleTypeInput,
} from './codegen.js';
export { resolveAllSchemas, resolveSchema } from './schema-resolver.js';
export type { JsonSchema, SchemaResolution } from './schema-resolver.js';
