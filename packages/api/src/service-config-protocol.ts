/**
 * Typed application-manifest entry for service-configuration announcements.
 *
 * Applications that opt a {@link ConnectionStore} into live endpoint watching
 * should register this protocol with an explicit read-only permission:
 *
 * ```ts
 * defineApplicationManifest({
 *   protocols: [
 *     { protocol: ServiceConfigProtocol, permissions: ['read'] },
 *   ],
 * });
 * ```
 */

import type { ServiceConfig } from '@enbox/auth';

import { ServiceConfigProtocolDefinition } from '@enbox/auth';

import { defineProtocol } from './define-protocol.js';
import { recordCodecs } from './record-codec.js';

/** Typed read model for the built-in service-config announcement protocol. */
export const ServiceConfigProtocol = defineProtocol(
  ServiceConfigProtocolDefinition,
  { serviceConfig: recordCodecs.json<ServiceConfig>() },
);
