# Preferences

Explicit locale, accessibility, appearance, communication, and selected domain preferences.

Module URI: `https://identity.foundation/modules/preferences`

Import `PreferencesModule`, `PreferencesDefinition`, `PreferencesCodecs`, and `PreferencesSchemas` from `@enbox/modules/preferences`. `PreferencesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `theme` | [JSON Schema](schemas/theme.json) | Plaintext | Mutable |
| `locale` | [JSON Schema](schemas/locale.json) | Plaintext | Mutable |
| `privacy` | [JSON Schema](schemas/privacy.json) | Encrypted | Mutable |
| `notification` | [JSON Schema](schemas/notification.json) | Plaintext | Mutable |
| `accessibility` | [JSON Schema](schemas/accessibility.json) | Encrypted | Mutable |
| `food` | [JSON Schema](schemas/food.json) | Encrypted | Mutable |
| `travel` | [JSON Schema](schemas/travel.json) | Encrypted | Mutable |
| `communication` | [JSON Schema](schemas/communication.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { PreferencesModule } from '@enbox/modules/preferences';

const records = enbox.using(PreferencesModule).records;
await records.create('theme', {
  data: {
  "mode": "system"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
