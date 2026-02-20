/**
 * Profile Protocol — public and semi-private identity information.
 *
 * Supports a published profile record, avatar and hero images (binary),
 * links, and private notes visible only to friends (via Social Graph
 * composition).
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a profile record. */
export type ProfileData = {
  displayName: string;
  bio?: string;
  tagline?: string;
  location?: string;
  website?: string;
  pronouns?: string;
};

/** Avatar is stored as binary data (Blob). */
export type AvatarData = Blob;

/** Hero banner is stored as binary data (Blob). */
export type HeroData = Blob;

/** Data shape for a link record (e.g. social links). */
export type LinkData = {
  url: string;
  title: string;
  icon?: string;
  sortOrder?: number;
};

/** Data shape for a private note (visible only to friends). */
export type PrivateNoteData = {
  content: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ProfileSchemaMap = {
  profile: ProfileData;
  avatar: AvatarData;
  hero: HeroData;
  link: LinkData;
  privateNote: PrivateNoteData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ProfileDefinition = {
  protocol  : 'https://identity.foundation/protocols/profile',
  published : true,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
  },
  types: {
    profile: {
      schema      : 'https://identity.foundation/schemas/profile/profile',
      dataFormats : ['application/json'],
    },
    avatar: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
    hero: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
    link: {
      schema      : 'https://identity.foundation/schemas/profile/link',
      dataFormats : ['application/json'],
    },
    privateNote: {
      schema      : 'https://identity.foundation/schemas/profile/private-note',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    profile: {
      $size    : { max: 10000 },
      $actions : [
        { who: 'anyone', can: ['read'] },
      ],
      avatar: {
        $size    : { max: 1048576 },
        $actions : [
          { who: 'anyone', can: ['read'] },
        ],
      },
      hero: {
        $size    : { max: 2097152 },
        $actions : [
          { who: 'anyone', can: ['read'] },
        ],
      },
      link: {
        $actions: [
          { who: 'anyone', can: ['read'] },
        ],
      },
    },
    privateNote: {
      $actions: [
        { role: 'social:friend', can: ['read'] },
      ],
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Profile protocol for use with `dwn.using()`. */
export const ProfileProtocol = defineProtocol(
  ProfileDefinition,
  {} as ProfileSchemaMap,
);
