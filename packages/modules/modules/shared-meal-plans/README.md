# Shared Meal Plans

Meals planned for dates, eaters, portions, and recipe references. Uses an existing Collaboration space and its membership.

Module URI: `https://enbox.id/modules/shared-meal-plans/v1`

Import `SharedMealPlansModule`, `SharedMealPlansDefinition`, `SharedMealPlansCodecs`, and `SharedMealPlansSchemas` from `@enbox/modules/shared-meal-plans`. `SharedMealPlansCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
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
| `space/plan` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, delete<br>role collaboration:space/viewer: read |
| `space/plan/meal` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, co-delete<br>role collaboration:space/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- This is a concrete standard extension, generated from Meal Plans authoring source. Record payload schema identities are shared; membership comes only from the existing Collaboration space.
- Use this variant when the user has selected a shared space. Standalone Meal Plans remains appropriate for independently shared roots. Do not write the same fact into both variants.
- Admin and editor powers are explicitly declared per path. The owner controls space membership and subtree pruning. Personal root-level state is excluded from the shared subtree; keep it in the user's own module.

## Capture contract

**Identity:** Select the existing Collaboration space first. Match the selected plan, date and meal slot.

**Workflow:** Plan meals and link recipes; record consumption in Food Diary and shopping intent in Groceries. Membership comes from the selected space; keep personal state outside the shared subtree.

**Exclude:** Writing the same fact to both the standalone and shared variant. An eating observation or pantry stock change.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { SharedMealPlansModule } from '@enbox/modules/shared-meal-plans';

const records = enbox.using(SharedMealPlansModule).records;
await records.create('space/plan', {
  parentContextId,
  data: {
  "name": "This week"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
