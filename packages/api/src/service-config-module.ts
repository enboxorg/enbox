import { ServiceConfigModuleDefinition } from '@enbox/agent';

import { defineModule } from './define-module.js';
import { recordCodecs } from './record-codec.js';

/**
 * Read-only application module for live DWN endpoint-change prompts.
 * Include it in an application manifest with `permissions: ['read']`.
 */
export const ServiceConfigModule = defineModule({
  definition : ServiceConfigModuleDefinition,
  codecs     : { serviceConfig: recordCodecs.json<Record<string, never>>() },
});
