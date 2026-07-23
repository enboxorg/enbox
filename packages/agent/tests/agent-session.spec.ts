import { describe, expect, test } from 'bun:test';

import { AgentSession } from '../src/agent-session.js';

describe('AgentSession', () => {
  test('constructor sets all readonly properties', () => {
    const agent = { agentDid: { uri: 'did:example:agent' } } as any;
    const identity = { didUri: 'did:example:user', name: 'User' };
    const controller = new AbortController();

    const session = new AgentSession({
      agent,
      did            : 'did:example:user',
      delegateDid    : 'did:example:delegate',
      recoveryPhrase : 'word1 word2 word3',
      identity,
      signal         : controller.signal,
    });

    expect(session.agent).toBe(agent);
    expect(session.did).toBe('did:example:user');
    expect(session.delegateDid).toBe('did:example:delegate');
    expect(session.recoveryPhrase).toBe('word1 word2 word3');
    expect(session.identity).toBe(identity);
    expect(session.signal).toBe(controller.signal);
    expect(session.signal.aborted).toBe(false);
    controller.abort();
    expect(session.signal.aborted).toBe(true);
  });

  test('rejects construction without a lifecycle-owner signal at runtime', () => {
    expect(() => new AgentSession({
      agent    : { agentDid: { uri: 'did:example:agent' } } as any,
      did      : 'did:example:user',
      identity : { didUri: 'did:example:user', name: 'User' },
    } as any)).toThrow('signal is required');
  });
});
