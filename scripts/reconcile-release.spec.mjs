import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createReleaseFixture, git, publish, run } from './test-utils/release-fixture.mjs';
import { registryVisibilityRetryDelay } from './reconcile-release.mjs';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const fixture = await createReleaseFixture();
  fixtures.push(fixture.directory);
  expect((await publish(fixture)).code).toBe(0);
  return fixture;
}

async function reconcile(fixture, env = {}) {
  return run([process.execPath, 'reconcile-release.mjs'], fixture.repo, { ...fixture.env, ...env });
}

describe('release metadata recovery', () => {
  it('bounds registry visibility backoff by the shared remaining time', () => {
    const missing = { code: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
    expect(registryVisibilityRetryDelay(missing, 0, 600_000)).toBe(1_000);
    expect(registryVisibilityRetryDelay(missing, 1, 600_000)).toBe(2_000);
    expect(registryVisibilityRetryDelay(missing, 20, 600_000)).toBe(30_000);
    expect(registryVisibilityRetryDelay(missing, 20, 100)).toBe(100);
    expect(registryVisibilityRetryDelay(missing, 20, 0)).toBeUndefined();
    expect(registryVisibilityRetryDelay(missing, 20, -1)).toBeUndefined();
  });

  it('does not retry authentication, command, or malformed-response failures', () => {
    for (const code of ['E401', 'E403', 'E500']) {
      const failure = { code: 1, stdout: JSON.stringify({ error: { code } }) };
      expect(registryVisibilityRetryDelay(failure, 0, 600_000)).toBeUndefined();
    }
    expect(registryVisibilityRetryDelay({ code: 2, stdout: '{"error":{"code":"E404"}}' }, 0, 600_000)).toBeUndefined();
    expect(registryVisibilityRetryDelay({ code: 1, stdout: 'not JSON' }, 0, 600_000)).toBeUndefined();
    expect(registryVisibilityRetryDelay({ code: 1, stdout: '{}' }, 0, 600_000)).toBeUndefined();
  });

  it('waits for an acknowledged publication to become visible without republishing', async () => {
    const fixture = await createFixture();
    const result = await reconcile(fixture, {
      METADATA_DELAY_PACKAGE: '@enbox/common@1.0.0',
      RELEASE_PUBLISHED_PACKAGES: JSON.stringify([{ name: '@enbox/common', version: '1.0.0' }]),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('publication acknowledged; registry metadata not visible yet');
    const calls = (await readFile(fixture.calls, 'utf8')).trim().split('\n');
    expect(calls.filter(line => line.startsWith('view @enbox/common@1.0.0 --json'))).toHaveLength(2);
    expect(calls.filter(line => line.startsWith('publish '))).toHaveLength(2);
  });

  it('does not wait for missing metadata without publication acknowledgement', async () => {
    const fixture = await createFixture();
    expect((await reconcile(fixture, { METADATA_DELAY_PACKAGE: '@enbox/common@1.0.0' })).code).not.toBe(0);
    const calls = (await readFile(fixture.calls, 'utf8')).trim().split('\n');
    expect(calls.filter(line => line.startsWith('view @enbox/common@1.0.0 --json'))).toHaveLength(1);
  });

  it('fails immediately for authentication errors even after publication acknowledgement', async () => {
    const fixture = await createFixture();
    const result = await reconcile(fixture, {
      METADATA_DELAY_PACKAGE: '@enbox/common@1.0.0',
      METADATA_DELAY_CODE: 'E403',
      RELEASE_PUBLISHED_PACKAGES: JSON.stringify([{ name: '@enbox/common', version: '1.0.0' }]),
    });
    expect(result.code).not.toBe(0);
    const calls = (await readFile(fixture.calls, 'utf8')).trim().split('\n');
    expect(calls.filter(line => line.startsWith('view @enbox/common@1.0.0 --json'))).toHaveLength(1);
  });

  it('rejects malformed publication acknowledgements before registry or remote writes', async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture.calls, 'utf8');
    expect((await reconcile(fixture, { RELEASE_PUBLISHED_PACKAGES: '{}' })).code).not.toBe(0);
    expect(await readFile(fixture.calls, 'utf8')).toBe(before);
    expect(await git(fixture, 'ls-remote', '--tags', 'origin')).toBe('');
  });

  it('recovers missing tags and releases after npm succeeds, and is idempotent', async () => {
    const fixture = await createFixture();
    expect(await git(fixture, 'ls-remote', '--tags', 'origin')).toBe('');
    const result = await reconcile(fixture);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    for (const name of ['common', 'crypto']) {
      const tag = `@enbox/${name}@1.0.0`;
      expect(await git(fixture, 'rev-parse', `${tag}^{commit}`)).toBe(await git(fixture, 'rev-parse', 'HEAD'));
      const release = JSON.parse(await readFile(join(fixture.env.RELEASE_GITHUB, encodeURIComponent(tag) + '.json'), 'utf8'));
      expect(release.tag_name).toBe(tag);
      expect(release.body).toBe('Release notes.');
    }
    const tags = await git(fixture, 'ls-remote', '--tags', 'origin');
    const calls = await readFile(fixture.calls, 'utf8');
    expect((await reconcile(fixture)).code).toBe(0);
    expect(await git(fixture, 'ls-remote', '--tags', 'origin')).toBe(tags);
    expect((await readFile(join(fixture.env.RELEASE_GITHUB, 'posts'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await readFile(fixture.calls, 'utf8')).split('\n').filter(line => line.startsWith('publish ')))
      .toEqual(calls.split('\n').filter(line => line.startsWith('publish ')));
  });

  it('completes a retry after an actual git push failure', async () => {
    const fixture = await createFixture();
    const realGit = Bun.which('git');
    const wrapper = join(fixture.directory, 'bin/git');
    await writeFile(wrapper, `#!/usr/bin/env bash
if [ "$1" = push ] && [ ! -f "$RELEASE_GITHUB/failed-push" ]; then
  touch "$RELEASE_GITHUB/failed-push"
  exit 1
fi
exec '${realGit}' "$@"
`);
    await chmod(wrapper, 0o755);
    expect((await reconcile(fixture)).code).not.toBe(0);
    expect((await reconcile(fixture)).code).toBe(0);
    expect((await git(fixture, 'ls-remote', '--tags', 'origin')).match(/\^\{\}/g)).toHaveLength(2);
  });

  it('repairs a missing GitHub release without recreating completed releases', async () => {
    const fixture = await createFixture();
    expect((await reconcile(fixture, { FAIL_RELEASE_ONCE: '1' })).code).not.toBe(0);
    expect((await reconcile(fixture)).code).toBe(0);
    expect((await reconcile(fixture)).code).toBe(0);
    expect((await readFile(join(fixture.env.RELEASE_GITHUB, 'posts'), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('leaves historical versions and their original tag objects unchanged', async () => {
    const fixture = await createFixture();
    await git(fixture, 'push', 'origin', '--tags');
    const original = await git(fixture, 'ls-remote', '--tags', 'origin');
    await git(fixture, 'commit', '--allow-empty', '-m', 'later commit');
    const legacyFile = join(fixture.env.RELEASE_REGISTRY, encodeURIComponent('@enbox/common') + '.json');
    const legacy = JSON.parse(await readFile(legacyFile, 'utf8'));
    delete legacy.gitHead;
    await writeFile(legacyFile, JSON.stringify(legacy));
    expect((await reconcile(fixture)).code).toBe(0);
    expect(await git(fixture, 'ls-remote', '--tags', 'origin')).toBe(original);
    expect(await Bun.file(join(fixture.env.RELEASE_GITHUB, 'posts')).exists()).toBe(false);
  });

  it('accepts a release created before its POST response is lost', async () => {
    const fixture = await createFixture();
    expect((await reconcile(fixture, { FAIL_RELEASE_RESPONSE_ONCE: '1' })).code).toBe(0);
    expect((await reconcile(fixture)).code).toBe(0);
    expect((await readFile(join(fixture.env.RELEASE_GITHUB, 'posts'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('recovers the completed part of a failed npm batch and finishes on retry', async () => {
    const fixture = await createReleaseFixture();
    fixtures.push(fixture.directory);
    expect((await publish(fixture, { FAIL_PACKAGE: 'crypto' })).code).not.toBe(0);
    expect((await reconcile(fixture)).code).not.toBe(0);
    expect(await Bun.file(join(fixture.env.RELEASE_GITHUB, encodeURIComponent('@enbox/common@1.0.0') + '.json')).exists()).toBe(true);
    expect((await publish(fixture)).code).toBe(0);
    expect((await reconcile(fixture)).code).toBe(0);
    expect((await git(fixture, 'ls-remote', '--tags', 'origin')).match(/\^\{\}/g)).toHaveLength(2);
  });

  it('refuses a current-release tag bound to another commit', async () => {
    const fixture = await createFixture();
    const old = await git(fixture, 'rev-parse', 'HEAD^');
    const tag = '@enbox/common@1.0.0';
    await git(fixture, 'tag', '-d', tag);
    await git(fixture, 'tag', '-a', tag, old, '-m', tag);
    await git(fixture, 'push', 'origin', `refs/tags/${tag}`);
    const result = await reconcile(fixture);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('points to a different commit');
    expect(await git(fixture, 'rev-parse', `${tag}^{commit}`)).toBe(old);
  });

  it('rejects conflicting registry provenance for a newly versioned package', async () => {
    const fixture = await createFixture();
    const manifest = join(fixture.repo, 'packages/common/package.json');
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    pkg.version = '2.0.0';
    await writeFile(manifest, JSON.stringify(pkg));
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '-m', 'new version');
    const registry = join(fixture.env.RELEASE_REGISTRY, encodeURIComponent(pkg.name) + '.json');
    const published = JSON.parse(await readFile(registry, 'utf8'));
    await writeFile(registry, JSON.stringify({ ...published, version: pkg.version }));
    const result = await reconcile(fixture, {
      RELEASE_PUBLISHED_PACKAGES: JSON.stringify([{ name: pkg.name, version: pkg.version }]),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('was not published from release commit');
    expect(await git(fixture, 'ls-remote', '--tags', 'origin')).toBe('');
  });
});
