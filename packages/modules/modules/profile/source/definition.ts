import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

// The web wallet pins this public URI to the definition shipped in @enbox/modules@0.2.124.
export const definition = {
  module    : 'https://identity.foundation/modules/profile',
  published : true,
  types     : {
    profile: {
      dataFormats : ['application/json'],
      schema      : 'https://identity.foundation/schemas/profile/profile',
    },
    link: {
      dataFormats : ['application/json'],
      schema      : 'https://identity.foundation/schemas/profile/link',
    },
    avatar: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
    hero: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
  },
  structure: {
    profile: {
      $size: {
        max: 10000,
      },
      $recordLimit: {
        max: 1,
      },
      $actions: [
        {
          who : 'anyone',
          can : ['read'],
        },
      ],
      link: {
        $actions: [
          {
            who : 'anyone',
            can : ['read'],
          },
        ],
      },
      avatar: {
        $size: {
          max: 12582912,
        },
        $recordLimit: {
          max: 1,
        },
        $actions: [
          {
            who : 'anyone',
            can : ['read'],
          },
        ],
      },
      hero: {
        $size: {
          max: 25165824,
        },
        $recordLimit: {
          max: 1,
        },
        $actions: [
          {
            who : 'anyone',
            can : ['read'],
          },
        ],
      },
    },
  },
} as const satisfies ModuleDefinition;
