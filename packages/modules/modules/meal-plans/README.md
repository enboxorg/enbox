# Meal Plans

Meals planned for dates, eaters, portions, and recipe references.

Module URI: `https://enbox.id/modules/meal-plans/v1`

Import `MealPlansModule`, `MealPlansDefinition`, `MealPlansCodecs`, and `MealPlansSchemas` from `@enbox/modules/meal-plans`. `MealPlansCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `plan` | [JSON Schema](schemas/plan.json) | Encrypted | Mutable |
| `plan/meal` | [JSON Schema](schemas/meal.json) | Encrypted | Mutable |
| `plan/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `plan/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |
| `space/plan` | [JSON Schema](schemas/plan.json) | Encrypted | Mutable |
| `space/plan/meal` | [JSON Schema](schemas/meal.json) | Encrypted | Mutable |

## Dependencies and ownership

- `collaboration`: [Collaboration](../collaboration/README.md) — `https://enbox.id/modules/collaboration/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `plan` | role plan/editor: read, co-update<br>role plan/viewer: read |
| `plan/meal` | role plan/editor: create, read, co-update, co-delete<br>role plan/viewer: read |
| `plan/editor` | recipient of plan/editor: read<br>recipient of this record: co-delete |
| `plan/viewer` | recipient of plan/viewer: read<br>recipient of this record: co-delete |
| `space/plan` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, delete<br>role collaboration:space/viewer: read |
| `space/plan/meal` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, co-delete<br>role collaboration:space/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- The same module and payload schemas support two ownership choices. Use plan for an independent record or space/plan when the user selects an existing Collaboration space. The selected space supplies its membership.

## Capture contract

**Identity:** Match the selected plan, date and meal slot.

**Workflow:** Plan meals and link recipes; record consumption in Food Diary and shopping intent in Groceries.

**Exclude:** An eating observation or pantry stock change.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { MealPlansModule } from '@enbox/modules/meal-plans';

const records = enbox.using(MealPlansModule).records;
await records.create('plan', {
  data: {
  "name": "This week"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
