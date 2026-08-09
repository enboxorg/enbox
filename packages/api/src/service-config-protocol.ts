import type { ServiceConfigNotice } from '@enbox/agent';

import { ServiceConfigProtocolDefinition } from '@enbox/agent';

import { defineProtocol } from './define-protocol.js';
import { recordCodecs } from './record-codec.js';

/**
 * Read-only application protocol for live DWN endpoint-change prompts.
 * Include it in an application manifest with `permissions: ['read']`.
 */
export const ServiceConfigProtocol = defineProtocol(
  ServiceConfigProtocolDefinition,
  { serviceConfig: recordCodecs.json<ServiceConfigNotice>() },
);

export type { ServiceConfigNotice } from '@enbox/agent';
