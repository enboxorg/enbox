import { describe, expect, test } from 'bun:test';

import { AuthSession } from '../src/identity-session.js';

describe('AuthSession', () => {
  test('constructor sets all readonly properties', () => {
    const mockWeb5 = { agent: {}, did: {} } as any;
    const identity = { didUri: 'did:example:test', name: 'Test Identity' };

    const session = new AuthSession({
      web5         : mockWeb5,
      did          : 'did:example:test',
      delegateDid  : 'did:example:delegate',
      recoveryPhrase : 'word1 word2 word3',
      identity,
    });

    expect(session.web5).toBe(mockWeb5);
    expect(session.did).toBe('did:example:test');
    expect(session.delegateDid).toBe('did:example:delegate');
    expect(session.recoveryPhrase).toBe('word1 word2 word3');
    expect(session.identity).toEqual(identity);
  });

  test('optional fields are undefined when not provided', () => {
    const mockWeb5 = { agent: {}, did: {} } as any;
    const identity = { didUri: 'did:example:test', name: 'Test' };

    const session = new AuthSession({
      web5     : mockWeb5,
      did      : 'did:example:test',
      identity,
    });

    expect(session.delegateDid).toBeUndefined();
    expect(session.recoveryPhrase).toBeUndefined();
  });
});
