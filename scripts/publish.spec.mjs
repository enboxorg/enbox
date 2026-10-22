import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function run(command, cwd, env) {
  const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

async function git(fixture, ...args) {
  const result = await run(['git', ...args], fixture.repo, fixture.env);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enbox-publish-'));
  fixtures.push(directory);
  const repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  await mkdir(repo);
  await mkdir(bin);
  const fixture = {
    directory,
    repo,
    output : join(directory, 'receipts.ndjson'),
    calls  : join(directory, 'npm-calls'),
    env    : {
      ...process.env,
      PATH              : `${bin}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL : '/dev/null',
      GIT_CONFIG_SYSTEM : '/dev/null',
      CHANGESETS_OUTPUT : join(directory, 'receipts.ndjson'),
      PUBLISH_CALLS     : join(directory, 'npm-calls'),
      ALREADY_PUBLISHED : '',
      FAIL_PACKAGE      : '',
    },
  };
  await writeFile(fixture.calls, '');
  // These executables ensure no test can call the real npm registry or pack command.
  await writeFile(join(bin, 'npm'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$PUBLISH_CALLS"
if [ "$1" = view ]; then
  if [ "\${ALREADY_PUBLISHED:-}" = 1 ]; then printf '1.0.0\\n'; exit 0; fi
  exit 1
fi
if [ "$1" = publish ]; then
  if [[ "$2" == *"\${FAIL_PACKAGE:-never-match}"* ]]; then exit 1; fi
  exit 0
fi
exit 99
`);
  await writeFile(join(bin, 'bun'), `#!/usr/bin/env bash
set -eu
[ "$1" = pm ] && [ "$2" = pack ] || exit 99
touch artifact.tgz
printf 'artifact.tgz\\n'
`);
  await Promise.all(['npm', 'bun'].map(name => chmod(join(bin, name), 0o755)));
  await copyFile(new URL('./publish.sh', import.meta.url), join(repo, 'publish.sh'));
  for (const name of ['common', 'crypto']) {
    await mkdir(join(repo, 'packages', name), { recursive: true });
    await writeFile(join(repo, 'packages', name, 'package.json'), JSON.stringify({
      name    : `@enbox/${name}`,
      version : '1.0.0',
      ...(name === 'crypto' ? { dependencies: { '@enbox/common': 'workspace:*' } } : {}),
    }));
  }
  await git(fixture, 'init', '--bare', join(directory, 'origin.git'));
  await git(fixture, 'init');
  await git(fixture, 'config', 'user.name', 'Publish fixture');
  await git(fixture, 'config', 'user.email', 'publish-fixture@example.invalid');
  await git(fixture, 'config', 'commit.gpgsign', 'false');
  await git(fixture, 'config', 'tag.gpgsign', 'false');
  await git(fixture, 'remote', 'add', 'origin', join(directory, 'origin.git'));
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '-m', 'fixture');
  return fixture;
}

async function publish(fixture, overrides = {}) {
  return run(['bash', 'publish.sh'], fixture.repo, { ...fixture.env, ...overrides });
}

async function receipts(fixture) {
  const contents = await readFile(fixture.output, 'utf8');
  return contents.trim() ? contents.trim().split('\n').map(line => JSON.parse(line)) : [];
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
