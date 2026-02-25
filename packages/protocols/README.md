# @enbox/protocols

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

Production-ready DWN protocol definitions for the Enbox ecosystem. Each protocol ships with:

- A raw `ProtocolDefinition` constant (e.g. `SocialGraphDefinition`)
- A typed protocol via `defineProtocol()` (e.g. `SocialGraphProtocol`)
- TypeScript data shape types (e.g. `FriendData`, `ProfileData`)
- A `SchemaMap` type mapping type names to data shapes
- JSON Schema files in `schemas/` for validation and code generation
- `$recordLimit` annotations on natural singleton types

## Installation

```bash
bun add @enbox/protocols
```

## Quick Start

```ts
import { repository, Web5 } from '@enbox/api';
import { ProfileProtocol, SocialGraphProtocol } from '@enbox/protocols';

const { web5 } = await Web5.connect({ password: 'secret' });

// Use the repository pattern for ergonomic CRUD
const social = repository(web5.using(SocialGraphProtocol));
await social.configure();

// Collections: create, query, get, delete, subscribe
const { record } = await social.friend.create({
  data: { did: 'did:dht:alice...', alias: 'Alice' },
});

const { records: friends } = await social.friend.query();
for (const f of friends) {
  const data = await f.data.json(); // FriendData -- typed
  console.log(data.alias);
}

// Singletons: set, get, delete
const profile = repository(web5.using(ProfileProtocol));
await profile.configure();

await profile.profile.set({
  data: { displayName: 'Bob', bio: 'Building the decentralized web' },
});

const { record: p } = await profile.profile.get();
console.log(await p.data.json()); // ProfileData
```

## Protocol Catalog

### Social Graph

**URI**: `https://identity.foundation/protocols/social-graph`
**Published**: yes
**Import**: `SocialGraphProtocol`, `SocialGraphDefinition`

Foundation protocol for relationship management. Other protocols compose with this via `uses` to leverage the `friend` role for cross-protocol authorization.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `friend` | `FriendData` | no | `$role: true` -- used for cross-protocol auth |
| `block` | `BlockData` | no | |
| `group` | `GroupData` | no | |
| `group/member` | `MemberData` | no | Nested under group |

```ts
type FriendData = { did: string; alias?: string; note?: string };
type BlockData  = { did: string; reason?: string };
type GroupData  = { name: string; description?: string; icon?: string };
type MemberData = { did: string; alias?: string };
```

---

### Profile

**URI**: `https://identity.foundation/protocols/profile`
**Published**: yes
**Composes with**: Social Graph (`social:friend` role for private notes)
**Import**: `ProfileProtocol`, `ProfileDefinition`

Public and semi-private identity information with avatar/hero images and social links.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `profile` | `ProfileData` | **yes** | 10 KB max |
| `profile/avatar` | `AvatarData` (Blob) | **yes** | 12 MB max, image formats |
| `profile/hero` | `HeroData` (Blob) | **yes** | 24 MB max, image formats |
| `profile/link` | `LinkData` | no | Social links nested under profile |
| `privateNote` | `PrivateNoteData` | no | Readable only by friends |

```ts
type ProfileData     = { displayName: string; bio?: string; tagline?: string; location?: string; website?: string; pronouns?: string };
type AvatarData      = Blob;  // no JSON schema -- binary only
type HeroData        = Blob;  // no JSON schema -- binary only
type LinkData        = { url: string; title: string; icon?: string; sortOrder?: number };
type PrivateNoteData = { content: string };
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

---

### Status

**URI**: `https://identity.foundation/protocols/status`
**Published**: yes
**Composes with**: Social Graph (friend-scoped reactions)
**Import**: `StatusProtocol`, `StatusDefinition`

Ephemeral status updates with reactions. Published statuses are readable by anyone; reactions are friend-scoped.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `status` | `StatusData` | no | 5 KB max |
| `status/reaction` | `ReactionData` | no | Friend-only create/read/delete |

```ts
type StatusData   = { text: string; emoji?: string; activity?: 'online' | 'away' | 'busy' | 'offline'; expiresAt?: string };
type ReactionData = { emoji: string };
```

---

### Lists

**URI**: `https://identity.foundation/protocols/lists`
**Published**: no
**Composes with**: Social Graph (friend-scoped reads, collaborator role)
**Import**: `ListsProtocol`, `ListsDefinition`

Flexible list management with collaboration. Supports nested items with tag-based hierarchy and 3-level folder nesting.

| Type | Data Shape | Singleton | Notes |
|------|-----------|-----------|-------|
| `list` | `ListData` | no | Tagged by `listType` |
| `list/item` | `ItemData` | no | Collaborators can CRUD |
| `list/item/comment` | `CommentData` | no | Collaborators can create/read |
| `list/collaborator` | `CollaboratorData` | no | `$role: true` for write access |
| `folder` | `FolderData` | no | 3-level nesting: `folder/folder/folder` |

```ts
type ListData         = { name: string; description?: string; icon?: string; listType: 'todo' | 'bookmarks' | 'reading' | 'custom' };
type ItemData         = { title: string; url?: string; note?: string; completed?: boolean; sortOrder?: number };
type CommentData      = { text: string };
type CollaboratorData = { did: string; alias?: string };
type FolderData       = { name: string; icon?: string; sortOrder?: number };
```

---

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

Each protocol type with `application/json` data format has a corresponding JSON Schema file in `schemas/<protocol>/<type>.json`. These schemas:

- Match the TypeScript data shapes exactly
- Use Draft-07 (`$schema: "http://json-schema.org/draft-07/schema#"`)
- Have `$id` URIs matching the `schema` field in the protocol definition
- Are compatible with `@enbox/protocol-codegen` for TypeScript type generation

```
schemas/
  social-graph/  friend.json, block.json, group.json, member.json
  profile/       profile.json, link.json, private-note.json
  preferences/   theme.json, locale.json, privacy.json, notification.json
  status/        status.json, reaction.json
  lists/         list.json, item.json, folder.json, collaborator.json, comment.json
  connect/       wallet.json
```

Binary-only types (`avatar`, `hero`) do not have JSON Schemas since they store raw image data.

## Singleton Detection

Types annotated with `$recordLimit: { max: 1, strategy: 'reject' }` in the protocol structure are treated as singletons by the `repository()` factory. This means:

- **Singletons** get `set()` (upsert) and `get()` instead of `create()` and `query()`
- The DWN engine enforces the limit -- a second `create` for a singleton is rejected
- Currently annotated singletons: `profile`, `avatar`, `hero`, `theme`, `locale`, `privacy`, `wallet`

## Exports

All protocols re-export from the package root:

```ts
import {
  // Social Graph
  SocialGraphProtocol, SocialGraphDefinition,
  type SocialGraphSchemaMap, type FriendData, type BlockData, type GroupData, type MemberData,

  // Profile
  ProfileProtocol, ProfileDefinition,
  type ProfileSchemaMap, type ProfileData, type AvatarData, type HeroData, type LinkData, type PrivateNoteData,

  // Preferences
  PreferencesProtocol, PreferencesDefinition,
  type PreferencesSchemaMap, type ThemeData, type LocaleData, type PrivacyData, type NotificationData,

  // Status
  StatusProtocol, StatusDefinition,
  type StatusSchemaMap, type StatusData, type ReactionData,

  // Lists
  ListsProtocol, ListsDefinition,
  type ListsSchemaMap, type ListData, type ItemData, type FolderData, type CollaboratorData, type CommentData,

  // Connect
  ConnectProtocol, ConnectDefinition,
  type ConnectSchemaMap, type WalletData,
} from '@enbox/protocols';
```

## License

Apache-2.0
