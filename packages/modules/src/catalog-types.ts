import type { ModuleActionRule, ModuleDefinition, ModuleTagsDefinition } from '@enbox/dwn-sdk-js';

/** JSON values exposed by the local schema directory. */
export type SchemaValue = null | boolean | number | string | readonly SchemaValue[] | { readonly [key: string]: SchemaValue };

/** A bundled JSON Schema; references are local to this document. */
export type PayloadSchema = { readonly [key: string]: SchemaValue };

/** A complete example for a concrete writable record path. */
export type ModuleRecordExample = {
  readonly path: string;
  readonly encoding: 'json' | 'base64' | 'file-envelope';
  readonly data: SchemaValue;
  readonly dataFormat?: string;
  readonly tags?: Readonly<Record<string, string>>;
};

/** A locally owned record contract. Virtual attachment paths are excluded. */
export type ModuleRecordContract = {
  readonly path: string;
  readonly type: string;
  readonly dataFormats: readonly string[];
  readonly encryptionRequired: boolean;
  readonly schemaUri?: string;
  readonly schema?: PayloadSchema;
  readonly role: boolean;
  readonly immutable: boolean;
  readonly singleton: boolean;
  readonly squashable: boolean;
  readonly maxBytes?: number;
  readonly actions: readonly ModuleActionRule[];
  readonly codec?: { readonly kind: 'file-envelope'; readonly formatId: string; readonly maxContentBytes: number };
  readonly tags?: ModuleTagsDefinition;
};

/** Discovery metadata backed by a complete definition, schemas, and examples. */
export type ModuleCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly uri: string;
  readonly exportName: string;
  readonly status: 'experimental';
  readonly captureExamples: readonly string[];
  readonly notes: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly definition: ModuleDefinition;
  readonly records: readonly ModuleRecordContract[];
  readonly examples: readonly ModuleRecordExample[];
};
