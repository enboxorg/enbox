# Gifts

Recipients, occasions, gift ideas, budget, and purchase/wrapping/giving state.

Module URI: `https://enbox.id/modules/gifts/v1`

Import `GiftsModule`, `GiftsDefinition`, `GiftsCodecs`, and `GiftsSchemas` from `@enbox/modules/gifts`. `GiftsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `plan` | [JSON Schema](schemas/plan.json) | Encrypted | Mutable |
| `plan/idea` | [JSON Schema](schemas/idea.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `plan` | Owner only |
| `plan/idea` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- A gift idea can reference an existing Shopping Wishlists list/item through wishlistItem. Linked ideas keep gifting state private and cannot duplicate name, URL, or product price fields.
- Use a standalone name/URL/price only when no existing wishlist item is selected. Linking does not grant the wishlist audience access to the gift plan.

## Capture contract

**Identity:** Match the selected gift plan, recipient, and occasion.

**Workflow:** Keep recipient and gifting decisions private. Reference an existing wishlist item instead of copying its name, URL and product price; link actual purchases separately.

**Exclude:** Sharing private gifting intent with a wishlist's audience automatically.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { GiftsModule } from '@enbox/modules/gifts';

const records = enbox.using(GiftsModule).records;
await records.create('plan', {
  data: {
  "name": "Birthday gift for Sam",
  "recipientName": "Sam",
  "occasion": "birthday"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
