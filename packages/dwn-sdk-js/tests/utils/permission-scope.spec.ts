import { describe, expect, it } from 'bun:test';

import { PermissionScopeMatcher, validatePermissionScope } from '../../src/utils/permission-scope.js';

describe('validatePermissionScope', () => {
  it('validates current scopes without normalizing or mutating them', () => {
    const scope = Object.freeze({ interface: 'Records', method: 'Read', module: 'https://example.com/module/', modulePath: 'protocol' });
    expect(() => validatePermissionScope(scope)).not.toThrow();
    expect(scope.module).toBe('https://example.com/module/');
    expect(scope.modulePath).toBe('protocol');
    expect(() => validatePermissionScope({ interface: 'Messages', method: 'Read' })).not.toThrow();
    expect(() => validatePermissionScope({ interface: 'Modules', method: 'Query', module: 'https://example.com/module' })).not.toThrow();
  });

  it('rejects old, mixed, and malformed permission scopes', () => {
    const scope = { interface: 'Records', method: 'Read', module: 'https://example.com/module' };
    for (const invalid of [
      undefined, null, [], {},
      { interface: 'Records', method: 'Read', protocol: scope.module },
      { ...scope, protocol: scope.module },
      { ...scope, protocolPath: 'note' },
      { ...scope, modulePath: 'note', protocolPath: 'note' },
      { ...scope, interface: 'Protocols', method: 'Query' },
    ]) {
      expect(() => validatePermissionScope(invalid)).toThrow();
    }
  });
});

describe('PermissionScopeMatcher', () => {
  it('matches unrestricted scopes', () => {
    expect(PermissionScopeMatcher.matches({}, { module: 'https://example.com/module' })).toBe(true);
  });

  it('matches module scopes exactly', () => {
    expect(PermissionScopeMatcher.matches(
      { module: 'https://example.com/module' },
      { module: 'https://example.com/module' },
    )).toBe(true);
    expect(PermissionScopeMatcher.matches(
      { module: 'https://example.com/module' },
      { module: 'https://example.com/module-sibling' },
    )).toBe(false);
  });

  it('matches modulePath scopes by subtree', () => {
    const scope = {
      module     : 'https://example.com/module',
      modulePath : 'thread/message',
    };

    expect(PermissionScopeMatcher.matches(scope, {
      module     : 'https://example.com/module',
      modulePath : 'thread/message',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      module     : 'https://example.com/module',
      modulePath : 'thread/message/reaction',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      module     : 'https://example.com/module',
      modulePath : 'thread/messageEvil',
    })).toBe(false);
  });

  it('matches contextId scopes by context subtree', () => {
    const scope = {
      module    : 'https://example.com/module',
      contextId : 'root',
    };

    expect(PermissionScopeMatcher.matches(scope, {
      module    : 'https://example.com/module',
      contextId : 'root',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches(scope, {
      module    : 'https://example.com/module',
      contextId : 'root/child',
    })).toBe(true);
    expect(PermissionScopeMatcher.matches({ ...scope, contextId: 'root/child' }, {
      module    : 'https://example.com/module',
      contextId : 'root',
    })).toBe(false);
    expect(PermissionScopeMatcher.matches(scope, {
      module    : 'https://example.com/module',
      contextId : 'rootEVIL',
    })).toBe(false);
    expect(PermissionScopeMatcher.matches(scope, {
      module: 'https://example.com/module',
    })).toBe(false);
    expect(PermissionScopeMatcher.matches(scope, {
      module    : 'https://example.com/module',
      contextId : 42 as any,
    })).toBe(false);
  });

  it('fails closed for path or context scopes without module', () => {
    expect(PermissionScopeMatcher.matches({ modulePath: 'thread' }, { modulePath: 'thread' })).toBe(false);
    expect(PermissionScopeMatcher.matches({ contextId: 'root' }, { contextId: 'root' })).toBe(false);
  });

  it('fails closed when modulePath and contextId are both present', () => {
    expect(PermissionScopeMatcher.matches({
      module     : 'https://example.com/module',
      modulePath : 'thread',
      contextId  : 'root',
    }, {
      module     : 'https://example.com/module',
      modulePath : 'thread',
      contextId  : 'root',
    })).toBe(false);
  });
});
