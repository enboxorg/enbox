import { describe, expect, it } from 'bun:test';

import { computeScopeId } from '../src/types/sync.js';

describe('computeScopeId', () => {
  it('should produce a deterministic string for a full scope', async () => {
    const id1 = await computeScopeId({ kind: 'full' });
    const id2 = await computeScopeId({ kind: 'full' });
    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
  });

  it('should produce different ids for different scope kinds', async () => {
    const fullId = await computeScopeId({ kind: 'full' });
    const protoId = await computeScopeId({ kind: 'protocol', protocol: 'https://example.com/proto' });
    expect(fullId).not.toBe(protoId);
  });

  it('should produce different ids for different protocols', async () => {
    const id1 = await computeScopeId({ kind: 'protocol', protocol: 'https://example.com/a' });
    const id2 = await computeScopeId({ kind: 'protocol', protocol: 'https://example.com/b' });
    expect(id1).not.toBe(id2);
  });

  it('should produce the same id regardless of array order', async () => {
    const id1 = await computeScopeId({
      kind                 : 'protocol',
      protocol             : 'https://example.com/proto',
      protocolPathPrefixes : ['b', 'a', 'c'],
    });
    const id2 = await computeScopeId({
      kind                 : 'protocol',
      protocol             : 'https://example.com/proto',
      protocolPathPrefixes : ['c', 'a', 'b'],
    });
    expect(id1).toBe(id2);
  });

  it('should produce url-safe base64 output (no +, /, or = characters)', async () => {
    // Run several inputs to increase confidence in the character set.
    for (let i = 0; i < 10; i++) {
      const id = await computeScopeId({ kind: 'protocol', protocol: `https://example.com/test-${i}` });
      expect(id).not.toContain('+');
      expect(id).not.toContain('/');
      expect(id).not.toContain('=');
    }
  });

  it('should dedupe and sort contextIdPrefixes', async () => {
    const id1 = await computeScopeId({
      kind              : 'protocol',
      protocol          : 'https://example.com/proto',
      contextIdPrefixes : ['b', 'a', 'b', 'c'],
    });
    const id2 = await computeScopeId({
      kind              : 'protocol',
      protocol          : 'https://example.com/proto',
      contextIdPrefixes : ['c', 'a', 'b'],
    });
    // Same after dedup + sort.
    expect(id1).toBe(id2);
  });

  it('should produce different ids with vs without contextIdPrefixes', async () => {
    const id1 = await computeScopeId({
      kind     : 'protocol',
      protocol : 'https://example.com/proto',
    });
    const id2 = await computeScopeId({
      kind              : 'protocol',
      protocol          : 'https://example.com/proto',
      contextIdPrefixes : ['ctx-1'],
    });
    expect(id1).not.toBe(id2);
  });
});
