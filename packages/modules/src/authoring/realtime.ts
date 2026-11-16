import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import { assertModulePath } from './roles.js';
import { validateAuthoredGraph } from './attachments.js';

export type RealtimeDefinitionOptions = {
  module: string;
  schemaBase: string;
  provider: ModuleDefinition;
  alias: string;
  parentPath: string;
  attachment: string;
  /** Provider roles in explicit preference order. Writers must also be readers. */
  readers: readonly string[];
  writers: readonly string[];
  dependencies?: readonly ModuleDefinition[];
};

/** Owner-managed encrypted rendezvous and immutable, writer-owned public peer sessions. */
export function realtimeDefinition(options: RealtimeDefinitionOptions): ModuleDefinition {
  const { alias, attachment, parentPath, readers, writers } = options;
  assertModulePath(attachment);
  assertModulePath(parentPath);
  if (attachment.includes('/') || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(alias)) {
    throw new TypeError('realtimeDefinition: attachment and alias must be single names.');
  }
  if (
    new Set(readers).size !== readers.length ||
    new Set(writers).size !== writers.length ||
    readers.length === 0 ||
    writers.some((role): boolean => !readers.includes(role))
  ) {
    throw new TypeError('realtimeDefinition: readers must be unique and contain every writer.');
  }
  for (const role of readers) {
    assertModulePath(role);
  }
  const definition: ModuleDefinition = {
    module    : options.module,
    published : true,
    uses      : { [alias]: options.provider.module },
    types     : {
      live    : { schema: `${options.schemaBase}/live`, dataFormats: ['application/json'], encryptionRequired: true },
      session : { schema: `${options.schemaBase}/session`, dataFormats: ['application/json'] },
    },
    structure: {
      [attachment]: {
        $ref : `${alias}:${parentPath}`,
        live : {
          $recordLimit : { max: 1 },
          $size        : { max: 2048 },
          $actions     : readers.map((role) => ({ role: `${alias}:${role}`, can: ['read'] })),
          session      : {
            $immutable : true,
            $size      : { max: 1024 },
            $actions   : readers.map((role) => ({
              role : `${alias}:${role}`,
              can  : writers.includes(role) ? ['create', 'delete', 'read'] : ['read'],
            })),
          },
        },
      },
    },
  };
  validateAuthoredGraph(definition, [options.provider, ...(options.dependencies ?? [])]);
  return definition;
}
