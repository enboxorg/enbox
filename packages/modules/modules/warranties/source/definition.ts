import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/warranties/v1',
  published : true,
  uses      : {
    belongings: 'https://enbox.id/modules/belongings/v1',
  },
  types: {
    warranty: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/warranties/v1/schemas/warranty',
    },
    claim: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/warranties/v1/schemas/claim',
    },
  },
  structure: {
    item: {
      $ref     : 'belongings:item',
      warranty : {
        $size: {
          max: 1048576,
        },
        $actions: [
          {
            role : 'belongings:item/editor',
            can  : ['create', 'read', 'co-update', 'co-delete', 'co-prune'],
          },
          {
            role : 'belongings:item/viewer',
            can  : ['read'],
          },
        ],
        claim: {
          $size: {
            max: 1048576,
          },
          $actions: [
            {
              role : 'belongings:item/editor',
              can  : ['create', 'read', 'co-update', 'co-delete'],
            },
            {
              role : 'belongings:item/viewer',
              can  : ['read'],
            },
          ],
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
