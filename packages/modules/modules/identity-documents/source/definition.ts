import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/identity-documents/v1',
  published : true,
  types     : {
    document: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/document',
    },
    extraction: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/extraction',
    },
    review: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/identity-documents/v1/schemas/review',
    },
  },
  structure: {
    document: {
      $size: {
        max: 1048576,
      },
      extraction: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
      review: {
        $size: {
          max: 1048576,
        },
        $immutable: true,
      },
    },
  },
} as const satisfies ModuleDefinition;
