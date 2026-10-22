import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function run(command, cwd, env) {
  const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

export async function git(fixture, ...args) {
  const result = await run(['git', ...args], fixture.repo, fixture.env);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function createReleaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enbox-publish-'));
  const repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  await mkdir(repo);
  await mkdir(bin);
  for (const name of ['registry', 'github', 'manifests']) {
    await mkdir(join(directory, name));
  }
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
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
      GITHUB_REPOSITORY  : 'enboxorg/fixture',
      RELEASE_REGISTRY  : join(directory, 'registry'),
      RELEASE_GITHUB    : join(directory, 'github'),
      RELEASE_MANIFESTS : join(directory, 'manifests'),
      FAIL_RELEASE_ONCE : '',
    },
  };
  await writeFile(fixture.calls, '');
  // These executables ensure no test can call the real npm registry or pack command.
  await copyFile(new URL('./mock-npm.cjs', import.meta.url), join(bin, 'npm'));
  await copyFile(new URL('./mock-gh.cjs', import.meta.url), join(bin, 'gh'));
  await writeFile(join(bin, 'bun'), `#!/usr/bin/env bash
set -eu
[ "$1" = pm ] && [ "$2" = pack ] || exit 99
cp package.json "$RELEASE_MANIFESTS/$(basename "$PWD").json"
touch artifact.tgz
printf 'artifact.tgz\\n'
`);
  await Promise.all(['npm', 'bun', 'gh'].map(name => chmod(join(bin, name), 0o755)));
  await copyFile(new URL('../publish.sh', import.meta.url), join(repo, 'publish.sh'));
  for (const name of ['common', 'crypto']) {
    await mkdir(join(repo, 'packages', name), { recursive: true });
    await writeFile(join(repo, 'packages', name, 'package.json'), JSON.stringify({
      name    : `@enbox/${name}`,
      version : '1.0.0',
      ...(name === 'crypto' ? { dependencies: { '@enbox/common': 'workspace:*' } } : {}),
    }));
  }
  await copyFile(new URL('../reconcile-release.mjs', import.meta.url), join(repo, 'reconcile-release.mjs'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/common', 'packages/crypto'] }));
  for (const name of ['common', 'crypto']) {
    await writeFile(join(repo, 'packages', name, 'CHANGELOG.md'), '# Fixture\n\n## 1.0.0\n\nRelease notes.\n');
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
  await git(fixture, 'commit', '--allow-empty', '-m', 'release');
  return fixture;
}

export async function publish(fixture, overrides = {}) {
  return run(['bash', 'publish.sh'], fixture.repo, { ...fixture.env, ...overrides });
}

export async function receipts(fixture) {
  const contents = await readFile(fixture.output, 'utf8');
  return contents.trim() ? contents.trim().split('\n').map(line => JSON.parse(line)) : [];
}
