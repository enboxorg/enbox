/**
 * Status Protocol — ephemeral status updates with reactions.
 *
 * Uses the `published` flag on individual records to control visibility:
 * published statuses are readable by anyone, unpublished ones only by friends.
 * Composes with Social Graph for friend-scoped access and reactions.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a status update. */
export type StatusData = {
  text: string;
  emoji?: string;
  activity?: 'online' | 'away' | 'busy' | 'offline';
  expiresAt?: string;
};

/** Data shape for a reaction to a status. */
export type ReactionData = {
  emoji: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type StatusSchemaMap = {
  status: StatusData;
  reaction: ReactionData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const StatusDefinition = {
  protocol  : 'https://identity.foundation/protocols/status',
  published : true,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
  },
  types: {
    status: {
      schema      : 'https://identity.foundation/schemas/status/status',
      dataFormats : ['application/json'],
    },
    reaction: {
      schema      : 'https://identity.foundation/schemas/status/reaction',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    status: {
      $size    : { max: 5000 },
      $actions : [
        { who: 'anyone', can: ['read'] },
        { role: 'social:friend', can: ['read'] },
      ],
      reaction: {
        $actions: [
          { role: 'social:friend', can: ['create', 'read', 'delete'] },
        ],
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Status protocol for use with `dwn.using()`. */
export const StatusProtocol = defineProtocol(
  StatusDefinition,
  {} as StatusSchemaMap,
);
