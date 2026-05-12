import { describe, expect, test } from 'bun:test';

import { AgentSession } from '../src/agent-session.js';

describe('AgentSession', () => {
  test('constructor sets all readonly properties', () => {
    const agent = { agentDid: { uri: 'did:example:agent' } } as any;
    const identity = { didUri: 'did:example:user', name: 'User' };

    const session = new AgentSession({
      agent,
      did            : 'did:example:user',
      delegateDid    : 'did:example:delegate',
      recoveryPhrase : 'word1 word2 word3',
      identity,
    });

    expect(session.agent).toBe(agent);
    expect(session.did).toBe('did:example:user');
    expect(session.delegateDid).toBe('did:example:delegate');
    expect(session.recoveryPhrase).toBe('word1 word2 word3');
    expect(session.identity).toBe(identity);
  });
});
