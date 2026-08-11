# @enbox/protocols

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

Ready-to-use DWN protocol definitions for the Enbox ecosystem. Each protocol ships with:

- A raw `ProtocolDefinition` constant (for example, `ProfileDefinition`)
- A typed protocol via `defineProtocol()` (for example, `ProfileProtocol`)
- TypeScript data shape types (for example, `ProfileData`)
- Runtime codecs mapping type names to application values
- JSON Schema files in `schemas/` for validation and code generation
- `$recordLimit` annotations on natural singleton types

## Installation

```bash
bun add @enbox/protocols
```

## Quick Start

```ts
import { createConnectionStore, defineApplicationManifest } from '@enbox/api';
import { ProfileProtocol } from '@enbox/protocols';

const application = defineApplicationManifest({
  protocols: [ProfileProtocol],
} as const);
const store = createConnectionStore({ application, password: 'secret' });

let snapshot = await store.initialize();
if (snapshot.phase === 'disconnected') {
  snapshot = await store.connectVault({ createIdentity: true });
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}

const profile = snapshot.enbox.using(ProfileProtocol);

await profile.records.create('profile', {
  data: { displayName: 'Bob', bio: 'Building the decentralized web' },
});

const { records: profiles } = await profile.records.query('profile');
console.log(await profiles[0].value()); // ProfileData

await store.disconnect();
await store.dispose();
```

## Protocol Catalog

### Profile

**URI**: `https://identity.foundation/protocols/profile`
**Published**: yes
**Import**: `ProfileProtocol`, `ProfileDefinition`

Public identity information with avatar and hero images and external links.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `profile` | `ProfileData` | **yes** | 10 KB max |
| `profile/avatar` | `AvatarData` (Blob) | **yes** | 12 MB max, image formats |
| `profile/hero` | `HeroData` (Blob) | **yes** | 24 MB max, image formats |
| `profile/link` | `LinkData` | no | Links nested under profile |

```ts
type ProfileData = { displayName: string; bio?: string; tagline?: string; location?: string; website?: string; pronouns?: string };
type AvatarData  = Blob; // no JSON schema -- binary only
type HeroData    = Blob; // no JSON schema -- binary only
type LinkData    = { url: string; title: string; icon?: string; sortOrder?: number };
```

---

### Preferences

**URI**: `https://identity.foundation/protocols/preferences`
**Published**: no (owner-only)
**Import**: `PreferencesProtocol`, `PreferencesDefinition`

User configuration and settings. The `privacy` type uses `encryptionRequired: true` for at-rest encryption.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `theme` | `ThemeData` | **yes** | |
| `locale` | `LocaleData` | **yes** | |
| `privacy` | `PrivacyData` | **yes** | Encrypted at rest |
| `notification` | `NotificationData` | no | Multiple channels, tagged by `channel` |

```ts
type ThemeData        = { mode: 'light' | 'dark' | 'system'; accentColor?: string; fontSize?: 'small' | 'medium' | 'large' };
type LocaleData       = { language: string; region?: string; timezone?: string; dateFormat?: string; hourCycle?: '12h' | '24h' };
type PrivacyData      = { cookieConsent: { analytics: boolean; marketing: boolean; functional: boolean }; shareUsageData: boolean };
type NotificationData = { channel: string; enabled: boolean; quietHoursStart?: string; quietHoursEnd?: string };
```

### Connect

**URI**: `https://identity.foundation/protocols/connect`
**Published**: yes
**Import**: `ConnectProtocol`, `ConnectDefinition`

Wallet and app discovery information.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `wallet` | `WalletData` | **yes** | Publicly readable |

```ts
type WalletData = { webWallets: string[] };
```

## JSON Schemas

Each protocol type with an `application/json` data format has a corresponding JSON Schema file in `schemas/<protocol>/<type>.json`. These schemas:

- Match the TypeScript data shapes exactly
- Use Draft-07 (`$schema: "http://json-schema.org/draft-07/schema#"`)
- Have `$id` URIs matching the `schema` field in the protocol definition
- Are compatible with `@enbox/protocol-codegen` for TypeScript type generation

```text
schemas/
  profile/       profile.json, link.json
  preferences/   theme.json, locale.json, privacy.json, notification.json
  connect/       wallet.json
```

Binary-only types (`avatar`, `hero`) do not have JSON Schemas since they store raw image data.

## Singleton Records

Types annotated with `$recordLimit: { max: 1 }` expose one deterministic occupant per parent scope through Query, Read, Count, and subscription snapshots:

- Create the record with `records.create()` and load it with `records.query()`.
- Update the returned `Record<T>` explicitly with `record.update()`.
- Competing valid writes remain stored but hidden from the projected population and may become visible if the current occupant is deleted.
- Currently annotated singletons: `profile`, `avatar`, `hero`, `theme`, `locale`, `privacy`, `wallet`.

## Exports

All protocols re-export from the package root:

```ts
import {
  // Profile
  ProfileProtocol, ProfileDefinition,
  type ProfileData, type AvatarData, type HeroData, type LinkData,

  // Preferences
  PreferencesProtocol, PreferencesDefinition,
  type ThemeData, type LocaleData, type PrivacyData, type NotificationData,

  // Connect
  ConnectProtocol, ConnectDefinition,
  type WalletData,
} from '@enbox/protocols';
```

## License

Apache-2.0
