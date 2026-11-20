# Warranties

Coverage terms, covered items, dates, providers, claim references, and evidence.

Module URI: `https://enbox.id/modules/warranties/v1`

Import `WarrantiesModule`, `WarrantiesDefinition`, `WarrantiesCodecs`, and `WarrantiesSchemas` from `@enbox/modules/warranties`. `WarrantiesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `item/warranty` | [JSON Schema](schemas/warranty.json) | Encrypted | Mutable |
| `item/warranty/claim` | [JSON Schema](schemas/claim.json) | Encrypted | Mutable |

## Dependencies and ownership

- `belongings`: [Belongings](../belongings/README.md) — `https://enbox.id/modules/belongings/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `item/warranty` | role belongings:item/editor: create, read, co-update, co-delete, co-prune<br>role belongings:item/viewer: read |
| `item/warranty/claim` | role belongings:item/editor: create, read, co-update, co-delete<br>role belongings:item/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Resolve the Belongings item and warranty provider/policy period.

**Workflow:** Attach coverage and claim records to the existing item and link evidence.

**Exclude:** A general insurance policy or an unverified claim outcome.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { WarrantiesModule } from '@enbox/modules/warranties';

const records = enbox.using(WarrantiesModule).records;
await records.create('item/warranty', {
  parentContextId,
  data: {
  "provider": "Example Appliances",
  "startsOn": "2026-01-15",
  "expiresOn": "2029-01-15"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
