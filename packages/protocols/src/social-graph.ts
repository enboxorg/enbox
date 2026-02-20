/**
 * Social Graph Protocol — foundation protocol for relationship management.
 *
 * Provides friend, block, group, and member types with role-based access.
 * Other protocols compose with this via `uses` to leverage the `friend` role
 * for cross-protocol authorization.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a friend record. */
export type FriendData = {
  did: string;
  alias?: string;
  note?: string;
};

/** Data shape for a block record. */
export type BlockData = {
  did: string;
  reason?: string;
};

/** Data shape for a group record. */
export type GroupData = {
  name: string;
  description?: string;
  icon?: string;
};

/** Data shape for a group member record. */
export type MemberData = {
  did: string;
  alias?: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type SocialGraphSchemaMap = {
  friend: FriendData;
  block: BlockData;
  group: GroupData;
  member: MemberData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const SocialGraphDefinition = {
  protocol  : 'https://identity.foundation/protocols/social-graph',
  published : true,
  types     : {
    friend: {
      schema      : 'https://identity.foundation/schemas/social-graph/friend',
      dataFormats : ['application/json'],
    },
    block: {
      schema      : 'https://identity.foundation/schemas/social-graph/block',
      dataFormats : ['application/json'],
    },
    group: {
      schema      : 'https://identity.foundation/schemas/social-graph/group',
      dataFormats : ['application/json'],
    },
    member: {
      schema      : 'https://identity.foundation/schemas/social-graph/member',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    friend: {
      $role    : true,
      $actions : [
        { who: 'anyone', can: ['create'] },
        { who: 'author', of: 'friend', can: ['read'] },
      ],
      $tags: {
        $requiredTags       : ['did'],
        $allowUndefinedTags : false,
        did                 : { type: 'string' },
      },
    },
    block: {
      $actions: [
        { who: 'anyone', can: ['create'] },
      ],
      $tags: {
        $requiredTags       : ['did'],
        $allowUndefinedTags : false,
        did                 : { type: 'string' },
      },
    },
    group: {
      $actions: [
        { who: 'anyone', can: ['read'] },
      ],
      member: {
        $actions: [
          { who: 'anyone', can: ['read'] },
        ],
        $tags: {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Social Graph protocol for use with `dwn.using()`. */
export const SocialGraphProtocol = defineProtocol(
  SocialGraphDefinition,
  {} as SocialGraphSchemaMap,
);
