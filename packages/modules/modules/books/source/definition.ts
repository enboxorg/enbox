import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

export const definition = {
  module    : 'https://enbox.id/modules/books/v1',
  published : true,
  types     : {
    book: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/books/v1/schemas/book',
    },
    reading: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/books/v1/schemas/reading',
    },
    highlight: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/books/v1/schemas/highlight',
    },
    review: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://enbox.id/modules/books/v1/schemas/review',
    },
  },
  structure: {
    book: {
      $size: {
        max: 1048576,
      },
      reading: {
        $size: {
          max: 1048576,
        },
      },
      highlight: {
        $size: {
          max: 1048576,
        },
      },
      review: {
        $size: {
          max: 1048576,
        },
      },
    },
  },
} as const satisfies ModuleDefinition;
