import { describe, expect, it } from 'bun:test';

import { PermissionScopeMatcher } from '../../src/utils/permission-scope.js';

describe('PermissionScopeMatcher', () => {
  it('matches unrestricted scopes', () => {
    expect(PermissionScopeMatcher.matches({}, { protocol: 'https://example.com/protocol' })).toBe(true);
  });

  it('matches protocol scopes exactly', () => {
    expect(PermissionScopeMatcher.matches(
      { protocol: 'https://example.com/protocol' },
      { protocol: 'https://example.com/protocol' },
    )).toBe(true);
    expect(PermissionScopeMatcher.matches(
      { protocol: 'https://example.com/protocol' },
      { protocol: 'https://example.com/protocol-sibling' },
    )).toBe(false);
  });

  it('matches protocolPath scopes exactly', () => {
    const scope = {
      protocol     : 'https://example.com/protocol',
      protocolPath : 'thread/message',
    };

    expect(PermissionScopeMatcher.matches(scope, {
      protocol     : 'https://example.com/protocol',
      protocolPath : 'thread/message',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      protocol     : 'https://example.com/protocol',
      protocolPath : 'thread/message/reaction',
    })).toBe(false);
  });

  it('matches contextId scopes by context subtree', () => {
    const scope = {
      protocol  : 'https://example.com/protocol',
      contextId : 'root',
    };

    expect(PermissionScopeMatcher.matches(scope, {
      protocol  : 'https://example.com/protocol',
      contextId : 'root',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      protocol  : 'https://example.com/protocol',
      contextId : 'root/child',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      protocol  : 'https://example.com/protocol',
      contextId : 'rootEVIL',
    })).toBe(false);
    expect(PermissionScopeMatcher.matches(scope, {
      protocol: 'https://example.com/protocol',
    })).toBe(false);
  });

  it('fails closed for path or context scopes without protocol', () => {
    expect(PermissionScopeMatcher.matches({ protocolPath: 'thread' }, { protocolPath: 'thread' })).toBe(false);
    expect(PermissionScopeMatcher.matches({ contextId: 'root' }, { contextId: 'root' })).toBe(false);
  });

  it('fails closed when protocolPath and contextId are both present', () => {
    expect(PermissionScopeMatcher.matches({
      protocol     : 'https://example.com/protocol',
      protocolPath : 'thread',
      contextId    : 'root',
    }, {
      protocol     : 'https://example.com/protocol',
      protocolPath : 'thread',
      contextId    : 'root',
    })).toBe(false);
  });
});
