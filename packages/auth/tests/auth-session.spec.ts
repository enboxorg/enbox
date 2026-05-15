import { AgentSession } from '@enbox/agent';
import { describe, expect, test } from 'bun:test';

import { AuthSession } from '../src/identity-session.js';

describe('AuthSession', () => {
  // `AuthSession` is a direct re-export of `AgentSession` (see
  // identity-session.ts). The constructor / readonly-property contract is
  // covered exhaustively in `@enbox/agent`'s `agent-session.spec.ts` — here
  // we only verify the alias relationship so a future divergence is caught.

  test('AuthSession === AgentSession (same class reference)', () => {
    expect(AuthSession).toBe(AgentSession);
  });

  test('instances created via `new AuthSession()` are AgentSession instances', () => {
    const mockAgent = { agentDid: { uri: 'did:example:agent' } } as any;
    const session = new AuthSession({
      agent    : mockAgent,
      did      : 'did:example:test',
      identity : { didUri: 'did:example:test', name: 'Test' },
    });
    expect(session).toBeInstanceOf(AgentSession);
    expect(session).toBeInstanceOf(AuthSession);
  });
});
