# Tasks

Actions, deadlines, completion state, and native alert/checklist data.

Module URI: `https://enbox.id/modules/tasks/v1`

Import `TasksModule`, `TasksDefinition`, `TasksCodecs`, and `TasksSchemas` from `@enbox/modules/tasks`. `TasksCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `task` | [JSON Schema](schemas/task.json) | Encrypted | Mutable |
| `task/checklistItem` | [JSON Schema](schemas/checklist-item.json) | Encrypted | Mutable |
| `state` | [JSON Schema](schemas/state.json) | Encrypted | Mutable |
| `task/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `task/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |
| `space/task` | [JSON Schema](schemas/task.json) | Encrypted | Mutable |
| `space/task/checklistItem` | [JSON Schema](schemas/checklist-item.json) | Encrypted | Mutable |

## Dependencies and ownership

- `collaboration`: [Collaboration](../collaboration/README.md) — `https://enbox.id/modules/collaboration/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `task` | role task/editor: read, co-update<br>role task/viewer: read |
| `task/checklistItem` | role task/editor: create, read, co-update, co-delete<br>role task/viewer: read |
| `state` | Owner only |
| `task/editor` | recipient of task/editor: read<br>recipient of this record: co-delete |
| `task/viewer` | recipient of task/viewer: read<br>recipient of this record: co-delete |
| `space/task` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, delete<br>role collaboration:space/viewer: read |
| `space/task/checklistItem` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, co-delete<br>role collaboration:space/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- The same module and payload schemas support two ownership choices. Use task for an independent record or space/task when the user selects an existing Collaboration space. The selected space supplies its membership.

## Capture contract

**Identity:** Match the selected task record, project and intended action.

**Workflow:** Maintain actionable state and shared checklists; keep private reminders and pinning in owner-local state.

**Exclude:** A calendar appointment or habit check-in as the same task fact.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { TasksModule } from '@enbox/modules/tasks';

const records = enbox.using(TasksModule).records;
await records.create('task', {
  data: {
  "title": "Call the dentist",
  "state": "todo",
  "dueOn": "2026-01-15"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
