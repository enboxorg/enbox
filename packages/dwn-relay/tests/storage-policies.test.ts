import { describe, expect, it } from 'bun:test';

import { parsePolicies, getRetentionMs } from '../src/eviction/storage-policies.js';

describe('parsePolicies', () => {
  it('should create a global default policy', () => {
    const policies = parsePolicies('72h', {});
    expect(policies).toHaveLength(1);
    expect(policies[0].protocol).toBe('*');
    expect(policies[0].retentionMs).toBe(259_200_000); // 72h
  });

  it('should add per-protocol overrides', () => {
    const policies = parsePolicies('72h', {
      'https://example.com/chat'  : '7d',
      'https://example.com/media' : '24h',
    });
    expect(policies).toHaveLength(3);
    expect(policies[0].protocol).toBe('*');
    expect(policies[1].protocol).toBe('https://example.com/chat');
    expect(policies[1].retentionMs).toBe(604_800_000); // 7d
    expect(policies[2].protocol).toBe('https://example.com/media');
    expect(policies[2].retentionMs).toBe(86_400_000); // 24h
  });

  it('should throw on invalid duration string in global', () => {
    expect(() => parsePolicies('invalid', {})).toThrow('Invalid duration');
  });

  it('should throw on invalid duration string in override', () => {
    expect(() => parsePolicies('72h', { 'proto://x': 'nope' })).toThrow('Invalid duration');
  });
});

describe('getRetentionMs', () => {
  const policies = parsePolicies('72h', {
    'https://example.com/chat'  : '7d',
    'https://example.com/media' : '24h',
  });

  it('should return protocol-specific retention when matched', () => {
    expect(getRetentionMs(policies, 'https://example.com/chat')).toBe(604_800_000);
    expect(getRetentionMs(policies, 'https://example.com/media')).toBe(86_400_000);
  });

  it('should return global default for unknown protocols', () => {
    expect(getRetentionMs(policies, 'https://other.com/proto')).toBe(259_200_000);
  });

  it('should return global default when protocol is undefined', () => {
    expect(getRetentionMs(policies, undefined)).toBe(259_200_000);
  });

  it('should return global default when protocol is empty string', () => {
    expect(getRetentionMs(policies, '')).toBe(259_200_000);
  });

  it('should return hardcoded fallback (72h) if no global policy exists', () => {
    // Edge case: empty policies array
    expect(getRetentionMs([], undefined)).toBe(259_200_000);
    expect(getRetentionMs([], 'any')).toBe(259_200_000);
  });
});
