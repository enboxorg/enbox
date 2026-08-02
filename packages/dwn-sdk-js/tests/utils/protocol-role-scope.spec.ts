import type { ProtocolDefinition } from '../../src/types/protocols-types.js';

import { describe, expect, it } from 'bun:test';

import { getProtocolRoleActionPaths } from '../../src/utils/protocols.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';

const definition = {
  protocol  : 'https://example.com/context',
  published : true,
  types     : {
    context : { dataFormats: ['application/json'] },
    member  : { dataFormats: ['application/json'] },
    note    : { dataFormats: ['application/json'] },
    secret  : { dataFormats: ['application/json'] },
    Zebra   : { dataFormats: ['application/json'] },
  },
  structure: {
    context: {
      $actions : [{ role: 'context/member', can: [ProtocolAction.Read] }],
      member   : { $role: true },
      note     : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Create, ProtocolAction.Read] }],
      },
      secret : {},
      Zebra  : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Read] }],
      },
    },
  },
} as const satisfies ProtocolDefinition;

describe('getProtocolRoleActionPaths', () => {
  it('returns exact paths in canonical code-unit order for all or one role action', () => {
    expect(getProtocolRoleActionPaths(definition, 'context/member')).toEqual([
      'context',
      'context/Zebra',
      'context/note',
    ]);
    expect(getProtocolRoleActionPaths(definition, 'context/member', ProtocolAction.Create)).toEqual([
      'context/note',
    ]);
    expect(getProtocolRoleActionPaths(definition, 'context/member', ProtocolAction.Read)).toEqual([
      'context',
      'context/Zebra',
      'context/note',
    ]);
  });
});
