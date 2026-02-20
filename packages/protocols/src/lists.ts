/**
 * Lists Protocol — flexible list management with folders and collaboration.
 *
 * Supports both nesting patterns:
 * - **Fixed-depth folders**: `folder/folder/folder` (3 levels max)
 * - **Flat items with tag-based hierarchy**: `list/item` with `parentItemId` tag
 *
 * Composes with Social Graph for friend-scoped read access and
 * defines a `collaborator` role for write access to shared lists.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for a list record. */
export type ListData = {
  name: string;
  description?: string;
  icon?: string;
  listType: 'todo' | 'bookmarks' | 'reading' | 'custom';
};

/** Data shape for a list item. */
export type ItemData = {
  title: string;
  url?: string;
  note?: string;
  completed?: boolean;
  sortOrder?: number;
};

/** Data shape for a folder record. */
export type FolderData = {
  name: string;
  icon?: string;
  sortOrder?: number;
};

/** Data shape for a collaborator record. */
export type CollaboratorData = {
  did: string;
  alias?: string;
};

/** Data shape for a comment on a list item. */
export type CommentData = {
  text: string;
};

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

/** Maps protocol type names to their TypeScript data shapes. */
export type ListsSchemaMap = {
  list: ListData;
  item: ItemData;
  folder: FolderData;
  collaborator: CollaboratorData;
  comment: CommentData;
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ListsDefinition = {
  protocol  : 'https://identity.foundation/protocols/lists',
  published : false,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
  },
  types: {
    list: {
      schema      : 'https://identity.foundation/schemas/lists/list',
      dataFormats : ['application/json'],
    },
    item: {
      schema      : 'https://identity.foundation/schemas/lists/item',
      dataFormats : ['application/json'],
    },
    folder: {
      schema      : 'https://identity.foundation/schemas/lists/folder',
      dataFormats : ['application/json'],
    },
    collaborator: {
      schema      : 'https://identity.foundation/schemas/lists/collaborator',
      dataFormats : ['application/json'],
    },
    comment: {
      schema      : 'https://identity.foundation/schemas/lists/comment',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    list: {
      $actions: [
        { role: 'social:friend', can: ['read'] },
      ],
      $tags: {
        $requiredTags       : ['listType'],
        $allowUndefinedTags : false,
        listType            : { type: 'string', enum: ['todo', 'bookmarks', 'reading', 'custom'] },
      },
      item: {
        $actions: [
          { role: 'social:friend', can: ['read'] },
          { role: 'list/collaborator', can: ['create', 'read', 'update', 'delete'] },
        ],
        $tags: {
          $allowUndefinedTags : true,
          parentItemId        : { type: 'string' },
        },
        comment: {
          $actions: [
            { role: 'list/collaborator', can: ['create', 'read'] },
          ],
        },
      },
      collaborator: {
        $role    : true,
        $actions : [
          { who: 'anyone', can: ['read'] },
        ],
        $tags: {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },
    },
    folder: {
      $tags: {
        $allowUndefinedTags : true,
        sortOrder           : { type: 'number' },
      },
      folder: {
        folder: {},
      },
    },
  },
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Lists protocol for use with `dwn.using()`. */
export const ListsProtocol = defineProtocol(
  ListsDefinition,
  {} as ListsSchemaMap,
);
