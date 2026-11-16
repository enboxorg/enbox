# Personal data modules

The personal data library is implemented in [`@enbox/modules`](../../packages/modules/README.md).
Each module has its own definition, JSON Schemas, typed codecs, discovery metadata,
examples, and documentation.

- Browse the [module library](../../packages/modules/README.md#module-library).
- Read the [individual artifact index](../../packages/modules/modules/index.json).
- Start with [Groceries](../../packages/modules/modules/groceries/README.md),
  [Stock Watchlists](../../packages/modules/modules/stock-watchlists/README.md),
  [Identity Documents](../../packages/modules/modules/identity-documents/README.md),
  or [Credentials](../../packages/modules/modules/credentials/README.md).
- Try the [household, notebook, and portfolio examples](../../packages/modules/examples/README.md).
- See [composition](../MODULE-COMPOSITION.md) for the engine's `uses`/`$ref` rules.

The package exports a searchable directory with the actual writable paths and
bundled payload schemas. Directory metadata supports discovery; definitions and
schemas determine what a record can contain and which actions are authorized.
