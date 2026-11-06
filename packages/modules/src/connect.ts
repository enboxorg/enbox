/**
 * Connect Module — wallet and app discovery information.
 *
 * Stores metadata about which wallet applications and services a DID
 * is associated with. Published so that other apps can discover how
 * to connect to this identity.
 *
 * @module
 */

import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { defineModule, recordCodecs } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for wallet connection info. */
export type WalletData = {
  /** URLs of web wallet applications associated with this DID. */
  webWallets: string[];
};

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

export const ConnectDefinition = {
  module    : 'https://identity.foundation/modules/connect',
  published : true,
  types     : {
    wallet: {
      schema      : 'https://identity.foundation/schemas/connect/wallet',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    wallet: {
      $recordLimit : { max: 1 },
      $actions     : [
        { who: 'anyone', can: ['read'] },
      ],
    },
  },
} as const satisfies ModuleDefinition;

// ---------------------------------------------------------------------------
// Typed module export
// ---------------------------------------------------------------------------

/** Typed Connect module for use with `enbox.using()`. */
export const ConnectModule = defineModule({ definition : ConnectDefinition, codecs     : {
  wallet: recordCodecs.json<WalletData>(),
} }
);
