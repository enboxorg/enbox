/**
 * Connect Protocol — wallet and app discovery information.
 *
 * Stores metadata about which wallet applications and services a DID
 * is associated with. Published so that other apps can discover how
 * to connect to this identity.
 *
 * @module
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { defineProtocol, recordCodecs } from '@enbox/api';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Data shape for wallet connection info. */
export type WalletData = {
  /** URLs of web wallet applications associated with this DID. */
  webWallets: string[];
};

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const ConnectDefinition = {
  protocol  : 'https://identity.foundation/protocols/connect',
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
} as const satisfies ProtocolDefinition;

// ---------------------------------------------------------------------------
// Typed protocol export
// ---------------------------------------------------------------------------

/** Typed Connect protocol for use with `dwn.using()`. */
export const ConnectProtocol = defineProtocol(
  ConnectDefinition,
  {
    wallet: recordCodecs.json<WalletData>(),
  },
);
