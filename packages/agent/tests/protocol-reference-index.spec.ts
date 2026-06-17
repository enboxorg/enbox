import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { ProtocolReferenceIndex } from '../src/protocol-reference-index.js';

describe('ProtocolReferenceIndex', () => {
  let db: Level<string, string>;
  let index: ProtocolReferenceIndex;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/protocol-reference-index-spec');
    index = new ProtocolReferenceIndex(db);
  });

  afterEach(async () => {
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('composes independent self and scope references for the same protocol', async () => {
    await index.assertSelfReference('did:example:alice', 'https://example.com/chat');
    await index.replaceScopeReferences('did:example:alice', 'did:example:alice', [
      'https://example.com/chat',
      'https://example.com/profile',
    ]);

    expect(await index.hasReference('did:example:alice', 'https://example.com/chat')).toBe(true);
    expect(await index.hasReference('did:example:alice', 'https://example.com/profile')).toBe(true);

    await index.deleteScopeReferences('did:example:alice', 'did:example:alice');

    const references = await index.getReferences('did:example:alice');
    expect(references.map(reference => ({
      kind     : reference.kind,
      protocol : reference.protocol,
    }))).toEqual([{
      kind     : 'self',
      protocol : 'https://example.com/chat',
    }]);
    expect(await index.hasReference('did:example:alice', 'https://example.com/chat')).toBe(true);
    expect(await index.hasReference('did:example:alice', 'https://example.com/profile')).toBe(false);
  });

  it('stores protocols all as a wildcard reference', async () => {
    await index.replaceScopeReferences('did:example:alice', 'did:example:alice', 'all');

    const references = await index.getReferences('did:example:alice');
    expect(references).toHaveLength(1);
    expect(references[0].kind).toBe('scope-all');
    expect(references[0].protocol).toBe(ProtocolReferenceIndex.wildcardProtocol);
    expect(await index.hasReference('did:example:alice', 'https://example.com/future')).toBe(true);
  });

  it('rewrites closure references for a source protocol', async () => {
    await index.replaceClosureReferences('did:example:alice', 'https://example.com/chat', [
      'https://example.com/profile',
      'https://example.com/tasks',
      'https://example.com/chat',
    ]);

    expect(await index.getExactReferencedProtocols('did:example:alice')).toEqual([
      'https://example.com/profile',
      'https://example.com/tasks',
    ]);

    await index.replaceClosureReferences('did:example:alice', 'https://example.com/chat', [
      'https://example.com/roles',
    ]);

    const references = await index.getReferences('did:example:alice');
    expect(references.map(reference => ({
      kind           : reference.kind,
      protocol       : reference.protocol,
      sourceProtocol : reference.sourceProtocol,
    }))).toEqual([{
      kind           : 'closure',
      protocol       : 'https://example.com/roles',
      sourceProtocol : 'https://example.com/chat',
    }]);
  });

  it('clears derived references without deleting self references', async () => {
    await index.assertSelfReference('did:example:alice', 'https://example.com/local');
    await index.replaceScopeReferences('did:example:alice', 'did:example:alice', ['https://example.com/synced']);
    await index.replaceClosureReferences('did:example:alice', 'https://example.com/synced', ['https://example.com/dep']);

    await index.clearDerivedReferences('did:example:alice');

    const references = await index.getReferences('did:example:alice');
    expect(references.map(reference => ({
      kind     : reference.kind,
      protocol : reference.protocol,
    }))).toEqual([{
      kind     : 'self',
      protocol : 'https://example.com/local',
    }]);
  });
});
