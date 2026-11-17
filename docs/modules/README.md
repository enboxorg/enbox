# Personal data modules

The personal data library is implemented in [`@enbox/modules`](../../packages/modules/README.md).
Its typed registry, raw artifact index, conversation index and Briand bundles publish the same module URIs. Each module defines its own record hierarchy, payload schemas, codecs and discovery metadata.

- Browse the [module library](../../packages/modules/README.md#module-library).
- See [conversation routing and specialized workflows](../../packages/modules/CHAT-DIRECTORY.md).
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
