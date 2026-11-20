# Subscriptions

Services, plans, recurring charges, trials, renewal dates, and cancellation state.

Module URI: `https://enbox.id/modules/subscriptions/v1`

Import `SubscriptionsModule`, `SubscriptionsDefinition`, `SubscriptionsCodecs`, and `SubscriptionsSchemas` from `@enbox/modules/subscriptions`. `SubscriptionsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `subscription` | [JSON Schema](schemas/subscription.json) | Encrypted | Mutable |
| `subscription/change` | [JSON Schema](schemas/change.json) | Encrypted | Immutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `subscription` | Owner only |
| `subscription/change` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match service/account and subscription instance or plan period.

**Workflow:** Maintain supplied subscription terms and changes; link accounts and bills without inventing cancellation actions.

**Exclude:** A recurring charge as proof of current subscription terms.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { SubscriptionsModule } from '@enbox/modules/subscriptions';

const records = enbox.using(SubscriptionsModule).records;
await records.create('subscription', {
  data: {
  "service": "Example Music",
  "state": "active",
  "billingCycle": "monthly"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
