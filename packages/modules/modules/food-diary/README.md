# Food Diary

Meals actually eaten, portions, times, and observations.

Module URI: `https://enbox.id/modules/food-diary/v1`

Import `FoodDiaryModule`, `FoodDiaryDefinition`, `FoodDiaryCodecs`, and `FoodDiarySchemas` from `@enbox/modules/food-diary`. `FoodDiaryCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `entry` | [JSON Schema](schemas/entry.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `entry` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { FoodDiaryModule } from '@enbox/modules/food-diary';

const records = enbox.using(FoodDiaryModule).records;
await records.create('entry', {
  data: {
  "occurredAt": "2026-01-15T12:00:00Z",
  "meal": "breakfast",
  "foods": [
    {
      "name": "Oatmeal"
    }
  ]
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
