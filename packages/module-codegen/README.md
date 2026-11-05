# @enbox/module-codegen

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

CLI tool and library for generating complete typed modules from DWN module definitions and JSON Schemas.

Given a module definition JSON file and a directory of JSON Schema files, it generates:

- TypeScript interfaces for each module type (via [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript))
- Runtime codecs for JSON, text, bytes, and variable-MIME `Blob` data
- Self-contained JSON Schema validators for resolved JSON payloads
- The complete module definition and a ready-to-use `defineModule()` result
- Strict, local JSON Schema resolution for every reachable JSON payload type
- Deterministic generated-output checks for CI

## Installation

```bash
bun add @enbox/api @enbox/dwn-sdk-js
bun add -D @enbox/module-codegen
```

Generated modules import the runtime codec helpers from `@enbox/api` and the
module definition type from `@enbox/dwn-sdk-js`, so both are direct app
dependencies. Browser-only apps can instead install `@enbox/browser` and pass
`--target browser`; generated code then imports only that package.

## CLI Usage

```bash
bunx @enbox/module-codegen generate \
  --definition ./my-module.json \
  --schemas ./schemas/ \
  --name MyModule \
  --output ./my-module.generated.ts
```

Add `--target browser` when the generated module should import solely from
`@enbox/browser`.

Generation is strict by default. Every module type reachable through the
module structure that declares exactly one `application/json` or
`application/*+json` MIME format must declare a schema URI and have a matching
local JSON Schema. The schema document must be a JSON object, its `$id` must be
a string that exactly equals the URI in the module definition, and every
`$ref` must be an in-document fragment beginning with `#`.

Use `check` in CI to verify committed output without modifying it:

```bash
bunx @enbox/module-codegen check \
  --definition ./my-module.json \
  --schemas ./schemas/ \
  --name MyModule \
  --output ./my-module.generated.ts
```

For example, package scripts can keep generation explicit and make freshness
part of the normal test workflow:

```json
{
  "scripts": {
    "generate:module": "module-codegen generate -d module.json -s schemas -n MyModule -o src/module.generated.ts",
    "check:module": "module-codegen check -d module.json -s schemas -n MyModule -o src/module.generated.ts"
  }
}
```

### Options

| Flag | Alias | Required | Description |
|------|-------|----------|-------------|
| `--definition` | `-d` | yes | Path to a JSON file containing the module definition |
| `--schemas` | `-s` | yes | Directory containing `.json` schema files |
| `--name` | `-n` | yes | PascalCase name for the module (e.g. `Inventory`) |
| `--output` | `-o` | no | Output file path. If omitted, prints to stdout |
| `--allow-unresolved` | | no | Explicitly emit `unknown` for reachable JSON types whose local schema is missing |
| `--target` | | no | Runtime import target: `api` (default) or `browser` |

The `check` command accepts the same options but requires `--output`. It
generates in memory, compares the exact UTF-8 output, and exits nonzero when
the file is missing or stale. It never creates or updates the output. Both
commands reject an output path whose final component is a symbolic link and
open output files with no-follow semantics.

### Output

The CLI reports resolution results to stderr and writes generated code to the output file (or stdout):

```
  + product: local-uri-path
  + category: local-uri-path

Wrote ./inventory.generated.ts
```

`+` means the schema was successfully resolved. `?` is only possible with
`--allow-unresolved` and means the JSON data type was emitted as `unknown`.

## Schema Resolution

The resolver uses two local strategies to find JSON Schema files for reachable
types with exactly one `application/json` or valid `application/*+json` MIME
format. Matching is case-insensitive and ignores MIME parameters. Text,
binary, mixed-format, and unreachable types are not resolved as JSON Schema
inputs; in particular, an invalid or missing schema for an unreachable
declaration does not affect generation.

### Strategy 1: Local file by type name

Looks for `<schemasDir>/<typeName>.json`.

```
schemas/
  product.json    <-- matches type "product"
  category.json   <-- matches type "category"
```

### Strategy 2: Local file by URI path

Extracts the path after `/schemas/` from the schema URI and looks for `<schemasDir>/<extracted-path>.json`.

For a schema URI `https://example.com/schemas/inventory/product`, it looks for:
```
schemas/inventory/product.json
```

This is how `@enbox/modules` organizes its schemas -- matching the URI structure exactly.

### Resolution result

Each type is reported with its resolution source:

| Source | Description |
|--------|-------------|
| `local-type-name` | Found at `<schemasDir>/<typeName>.json` |
| `local-uri-path` | Found at `<schemasDir>/<uri-path>.json` |
| `unresolved` | No local schema found; strict generation fails unless explicitly allowed |

Network resolution is deliberately unavailable: an unlocked remote response
would make generation depend on mutable external state. Vendor schemas in the
repository and bind each one to its definition URI with a string `$id`. Schema
documents must be JSON objects. External URI and file-system `$ref` values are
also rejected before compilation; compose a vendored schema with local
fragment references such as `#/$defs/item` instead.

## Example

Given this module definition (`todo.json`):

```json
{
  "module": "https://example.com/todo",
  "published": false,
  "types": {
    "list": {
      "schema": "https://example.com/schemas/todo/list",
      "dataFormats": ["application/json"]
    },
    "item": {
      "schema": "https://example.com/schemas/todo/item",
      "dataFormats": ["application/json"]
    },
    "attachment": {
      "dataFormats": ["application/octet-stream", "image/png"]
    }
  },
  "structure": {
    "list": {
      "item": {
        "attachment": {}
      }
    }
  }
}
```

And these schema files:

```
schemas/
  todo/
    list.json     # { "$id": "https://example.com/schemas/todo/list", "type": "object", ... }
    item.json     # { "$id": "https://example.com/schemas/todo/item", "type": "object", ... }
```

Running:

```bash
bunx @enbox/module-codegen generate \
  -d ./todo.json \
  -s ./schemas/ \
  -n Todo \
  -o ./todo.generated.ts
```

Generates:

```ts
/**
 * Auto-generated by @enbox/module-codegen.
 * Do not edit manually.
 */

import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { defineModule, recordCodecs, type RecordValidator } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface ListData {
  name: string;
}

export interface ItemData {
  title: string;
  done?: boolean;
}

/** Data shape for the `attachment` type (variable MIME). */
export type AttachmentData = Blob;

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

export const TodoDefinition = {
  module  : 'https://example.com/todo',
  published : false,
  types     : {
    list: {
      schema      : 'https://example.com/schemas/todo/list',
      dataFormats : ['application/json'],
    },
    item: {
      schema      : 'https://example.com/schemas/todo/item',
      dataFormats : ['application/json'],
    },
    attachment: {
      dataFormats: ['application/octet-stream', 'image/png'],
    },
  },
  structure: {
    list: {
      item: {
        attachment: {},
      },
    },
  },
} as const satisfies ModuleDefinition;

// The generated file contains the validator implementations; declarations
// are shown here only to keep this example short.
declare const moduleValidators: {
  validateItemData: RecordValidator;
  validateListData: RecordValidator;
};

// ---------------------------------------------------------------------------
// Runtime codecs
// ---------------------------------------------------------------------------

export const TodoCodecs = {
  list       : recordCodecs.json<ListData>({ validator: moduleValidators.validateListData }),
  item       : recordCodecs.json<ItemData>({ validator: moduleValidators.validateItemData }),
  attachment : recordCodecs.blob(),
} as const;

// ---------------------------------------------------------------------------
// Typed module
// ---------------------------------------------------------------------------

export const TodoModule = defineModule({
  definition: TodoDefinition,
  codecs: TodoCodecs,
});
```

Import `TodoModule` from the generated module and pass it directly to `Enbox.using()`.

Codec selection follows the declared representation: one JSON MIME type uses
`json<T>()`; one `text/*` format uses `text()`; one fixed binary format uses
`bytes()`; and multiple possible formats use `blob()` so each value carries
its MIME type. A schema never causes non-JSON bytes to be mislabeled as JSON.
Resolved JSON codecs validate the exact serialized representation on writes
and parsed values on reads. Their validators are generated into the module;
applications do not ship Ajv or a runtime schema compiler. Generated validators
stop after the first failing schema rule; custom `RecordValidator`
implementations may report multiple failures.

## Composed modules

Supply one dependency artifact for every direct `uses` alias. The generator
validates the same graph as `defineModule`, follows transitive dependencies,
and emits static imports of the existing typed providers. It never executes a
provider module or fetches a module URI over the network.

```ts
const coreDefinition = {
  module: 'https://example.com/modules/core',
  published: true,
  types: { note: { dataFormats: ['text/plain'] } },
  structure: { note: {} },
};

const commentsDefinition = {
  module: 'https://example.com/modules/comments',
  published: true,
  uses: { core: coreDefinition.module },
  types: { comment: { dataFormats: ['text/plain'] } },
  structure: { note: { $ref: 'core:note', comment: {} } },
};

const { code } = await generateModuleModule(commentsDefinition, {
  schemasDir: './schemas',
  moduleName: 'Comments',
  dependencies: {
    core: {
      definition: coreDefinition,
      importPath: './core.generated.js',
      exportName: 'CoreModule',
    },
  },
});
```

`importPath` is the import specifier relative to the generated consumer file
(or a package specifier). `exportName` names the provider's typed module export.
The artifact's `definition` must match the alias URI; its own `dependencies`
carry any transitive artifacts in the same shape. A shared provider in a
dependency diamond must have the same authored definition in every branch.

For CLI use, serialize this dependency map as JSON and pass
`--dependencies ./dependencies.json` to either `generate` or `check`. The
registry contains complete inline definitions and import metadata, not executable
JavaScript. Missing/extra aliases and conflicting artifacts fail before output.

Only locally owned record types receive codecs. A `$ref` attachment has no local
record or codec, while locally declared children below it remain ordinary typed
records. Their physical context depths come from the resolved graph. A genuine
local type with the same name as an attachment keeps its own representation.

## Programmatic API

The codegen engine can also be used as a library:

```ts
import { generateModuleCode } from '@enbox/module-codegen';

const definition = {
  module: 'https://example.com/my-module',
  types: {
    note: { schema: 'https://example.com/schemas/note', dataFormats: ['application/json'] },
  },
  structure: { note: {} },
};

const { code, resolutions } = await generateModuleCode(definition, {
  schemasDir   : './schemas',
  moduleName : 'MyModule',
});

// code is the generated TypeScript source string
// resolutions is a Map<string, SchemaResolution> with metadata about each type
```

### `generateModuleCode(definition, options)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `definition` | `ModuleDefinitionInput` | Module definition object with `module`, `types`, `structure` |
| `options.schemasDir` | `string` | Directory containing `.json` schema files |
| `options.moduleName` | `string` | PascalCase name for the generated definition, codecs, and typed module exports |
| `options.target` | `'api' \| 'browser'?` | Runtime import target (default: `'api'`) |
| `options.bannerComment` | `string?` | Custom banner comment at the top of the file (default: auto-generated notice) |
| `options.allowUnresolvedJsonSchemas` | `boolean?` | Explicitly allow missing local schemas for reachable JSON types (default: `false`) |

**Returns** `{ code: string; resolutions: Map<string, SchemaResolution> }`

### `resolveSchema(typeName, schemaUri, schemasDir)`

Resolve a single schema URI from the local schemas directory. Returns a
`SchemaResolution` with the parsed schema and its source. This API never
performs network requests.

### `resolveAllSchemas(types, schemasDir)`

Resolve all schema URIs from a module's `types` map. Returns a `Map<string, SchemaResolution>`.

## License

Apache-2.0
