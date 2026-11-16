import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { roleDefinition } from '../../../src/authoring/roles.js';

export const definition = {
  module    : 'https://enbox.id/modules/events/v1',
  published : true,
  types     : {
    event: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/events/v1/schemas/event',
    },
    exception: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/events/v1/schemas/exception',
    },
    response: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/events/v1/schemas/response',
    },
    state: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/events/v1/schemas/state',
    },
    editor: {
      schema             : 'https://enbox.id/modules/events/v1/schemas/editor',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    viewer: {
      schema             : 'https://enbox.id/modules/events/v1/schemas/viewer',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
    attendee: {
      schema             : 'https://enbox.id/modules/events/v1/schemas/attendee',
      dataFormats        : ['application/json'],
      encryptionRequired : false,
    },
  },
  structure: {
    event: {
      $size: {
        max: 1048576,
      },
      $actions: [
        {
          role : 'event/editor',
          can  : ['read', 'co-update'],
        },
        {
          role : 'event/attendee',
          can  : ['read'],
        },
        {
          role : 'event/viewer',
          can  : ['read'],
        },
      ],
      exception: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'event/editor',
            can  : ['create', 'read', 'co-update', 'co-delete'],
          },
          {
            role : 'event/attendee',
            can  : ['read'],
          },
          {
            role : 'event/viewer',
            can  : ['read'],
          },
        ],
      },
      response: {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'event/editor',
            can  : ['create', 'read', 'update', 'delete'],
          },
          {
            role : 'event/attendee',
            can  : ['create', 'read', 'update', 'delete'],
          },
          {
            role : 'event/viewer',
            can  : ['read'],
          },
        ],
      },
      editor   : roleDefinition('event/editor'),
      viewer   : roleDefinition('event/viewer'),
      attendee : roleDefinition('event/attendee'),
    },
    state: {
      $size: {
        max: 1048576,
      },
    },
  },
} as const satisfies ModuleDefinition;
