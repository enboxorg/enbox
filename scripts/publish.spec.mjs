import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';

import { createReleaseFixture, git, publish, receipts } from './test-utils/release-fixture.mjs';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const fixture = await createReleaseFixture();
  fixtures.push(fixture.directory);
  return fixture;
}

describe('custom publisher Changesets Action v2 receipts', () => {
  it('reports successful releases with verified local tags and restores workspace manifests', async () => {
    const fixture = await createFixture();
    const original = await readFile(join(fixture.repo, 'packages/crypto/package.json'), 'utf8');
    const result = await publish(fixture);
    expect(result.code).toBe(0);
    expect(await receipts(fixture)).toEqual(['common', 'crypto'].map(name => ({
      type: 'git-tag', tag: `@enbox/${name}@1.0.0`, packageName: `@enbox/${name}`,
    })));
    for (const name of ['common', 'crypto']) {
      expect(await git(fixture, 'rev-parse', `@enbox/${name}@1.0.0^{commit}`)).toBe(await git(fixture, 'rev-parse', 'HEAD'));
    }
    expect(await readFile(join(fixture.repo, 'packages/crypto/package.json'), 'utf8')).toBe(original);
    const packed = JSON.parse(await readFile(join(fixture.env.RELEASE_MANIFESTS, 'crypto.json'), 'utf8'));
    expect(packed.gitHead).toBe(await git(fixture, 'rev-parse', 'HEAD'));
    expect(packed.dependencies['@enbox/common']).toBe('1.0.0');
  });

  it('reports successful packages in a partial release and fails when another publish fails', async () => {
    const fixture = await createFixture();
    const result = await publish(fixture, { FAIL_PACKAGE: 'crypto' });
    expect(result.code).not.toBe(0);
    expect(await receipts(fixture)).toEqual([{ type: 'git-tag', tag: '@enbox/common@1.0.0', packageName: '@enbox/common' }]);
  });

  it('clears stale receipts and emits none for already-published versions', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.output, '{"type":"git-tag","tag":"stale","packageName":"stale"}\n');
    expect((await publish(fixture, { ALREADY_PUBLISHED: '1' })).code).toBe(0);
    expect(await receipts(fixture)).toEqual([]);
    expect(await readFile(fixture.calls, 'utf8')).not.toContain('publish ');
  });

  it('supports running the publisher outside Changesets Action', async () => {
    const fixture = await createFixture();
    expect((await publish(fixture, { CHANGESETS_OUTPUT: '' })).code).toBe(0);
    expect(await readFile(fixture.calls, 'utf8')).toContain('publish packages/common/artifact.tgz');
    expect(await Bun.file(fixture.output).exists()).toBe(false);
  });

  it('fails before registry calls when the receipt destination cannot be created', async () => {
    const fixture = await createFixture();
    expect((await publish(fixture, { CHANGESETS_OUTPUT: join(fixture.directory, 'missing', 'output') })).code).not.toBe(0);
    expect(await readFile(fixture.calls, 'utf8')).toBe('');
  });

  it('refuses a stale remote tag before publishing or emitting a receipt', async () => {
    const fixture = await createFixture();
    const tag = '@enbox/common@1.0.0';
    await git(fixture, 'tag', '-a', tag, '-m', tag);
    await git(fixture, 'push', 'origin', `refs/tags/${tag}`);
    await git(fixture, 'commit', '--allow-empty', '-m', 'new head');
    const result = await publish(fixture);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('already exists at a different commit');
    expect(await receipts(fixture)).toEqual([]);
    expect(await readFile(fixture.calls, 'utf8')).not.toContain('publish ');
  });
});
