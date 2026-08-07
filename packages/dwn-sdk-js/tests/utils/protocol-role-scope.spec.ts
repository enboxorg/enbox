import type { ProtocolDefinition } from '../../src/types/protocols-types.js';

import { describe, expect, it } from 'bun:test';

import { ProtocolAction } from '../../src/types/protocols-types.js';
import { resolveProtocolRoleContextScope } from '../../src/utils/protocols.js';

const definition = {
  protocol  : 'https://example.com/context',
  published : true,
  types     : {
    context : { dataFormats: ['application/json'] },
    draft   : { dataFormats: ['application/json'] },
    member  : { dataFormats: ['application/json'] },
    note    : { dataFormats: ['application/json'] },
    secret  : { dataFormats: ['application/json'] },
    Zebra   : { dataFormats: ['application/json'] },
  },
  structure: {
    context: {
      $actions : [{ role: 'context/member', can: [ProtocolAction.Read] }],
      member   : { $role: true },
      draft    : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Create] }],
      },
      note: {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Create, ProtocolAction.Read] }],
      },
      secret : {},
      Zebra  : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Read] }],
      },
    },
  },
} as const satisfies ProtocolDefinition;

describe('resolveProtocolRoleContextScope', () => {
  it('returns the context root and only its non-role authorized content paths', () => {
    const scope = resolveProtocolRoleContextScope(definition, 'context/member');

    expect(scope.protocolPath).toBe('context');
    expect(scope.readablePaths).toEqual(['context', 'context/Zebra', 'context/note']);
    expect([...scope.allowedPaths]).toEqual(['context', 'context/Zebra', 'context/draft', 'context/note']);
  });
});
