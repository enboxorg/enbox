# Data module format cutover

Enbox now calls its declarative data definitions **modules**. This release changes
the signed wire format, storage indexes, SDK names, package names, and first-party
definition identifiers together.

The names distinguish the identifier, the rules, and the API that uses them:

| Name | Meaning |
| --- | --- |
| `module` / local variable `moduleUri` | The URI that identifies a DWN data module. |
| `ModuleDefinition` / `definition` | The serializable types, structure, and authorization rules for that URI. |
| `modulePath` | A path through the definition's structure, such as `notebook/page`. |
| `moduleRole` | The role invoked to authorize an operation; it is separate from the record's own path. |
| `TypedModule` | A definition paired with application codecs by `defineModule`. |
| `Module` | The API wrapper around one signed `ModulesConfigure` message. |

Use an application name for the bound typed client, such as
`const notebooks = enbox.using(NotebookModule)`. Then
`notebooks.records.create(...)` clearly names the application being used.
JavaScript modules remain source-code import units; they are not DWN data modules.

Deploy matching versions of the DWN engine, server, clients, agent, SDK, connect
peers, and applications. Use `@enbox/modules`, `@enbox/module-codegen`,
`ModuleDefinition`, `ModulesConfigure`, `ModulesQuery`, and `enbox.modules`.
Signed descriptors, filters, grants, and connect payloads use `module`,
`modulePath`, and `moduleRole`. Path encryption uses the `modulePath` derivation
label; role-audience encryption retains `roleAudience` and `rolePath` with a
`module` namespace.

Before starting the new release, initialize fresh DWN message, data, and task
stores, agent/sync stores, and application sessions. Keep any required old data
backup separate. Old stores and sessions require explicit reinitialization;
opening them does not translate or migrate their content. Issue new module
configurations, records, grants, and encryption material. Previously queued
offline writes and sync checkpoints cannot cross this format boundary.

There are no old package aliases, wire-field aliases, dual readers, URI redirects,
or in-place signed-record conversions. Renaming a signed field or URI would change
its signature, content identity, and potentially its derived keys. Existing data
must never be relabeled and presented as the same signed record.

Within the new format, normal offline operations continue preserving signed
timestamps, ciphertext, and record identities. The cutover introduces neither
automatic key rotation nor re-encryption of existing new-format records.

Network protocols and platform properties such as `URL.protocol` retain their
standard names.
