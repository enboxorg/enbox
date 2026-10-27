import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isReleaseMetadataOnly } from './ci-release-metadata.mjs';

const workflow = Bun.YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const gate = workflow.jobs['ci-passed'];

/** Execute the actual gate shell with the same dependency values GitHub substitutes. */
async function checkResults(overrides = {}) {
  const values = Object.fromEntries(gate.needs.map(job => [`${job}.result`, 'success']));
  values['changes.outputs.src'] = 'true';
  Object.assign(values, overrides);
  const script = gate.steps[0].run.replace(/\$\{\{ needs\.([\w.-]+) \}\}/g, (_, key) => {
    if (!(key in values)) {
      throw new Error(`unhandled gate input: ${key}`);
    }
    return values[key];
  });
  const child = Bun.spawn(['bash', '-e', '-c', script], { stdout: 'ignore', stderr: 'ignore' });
  return child.exited;
}

describe('required CI gate', () => {
  it('accepts successful source checks and audited docs-only changes', async () => {
    expect(await checkResults()).toBe(0);
    const docs = Object.fromEntries(gate.needs.map(job => [`${job}.result`, 'skipped']));
    expect(await checkResults({ ...docs, 'changes.result': 'success', 'security.result': 'success', 'changes.outputs.src': 'false' })).toBe(0);
  });

  it('rejects failed change detection and missing or invalid outputs', async () => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(await checkResults({ 'changes.result': result, 'changes.outputs.src': '' })).not.toBe(0);
    }
    for (const src of ['', 'unknown']) {
      expect(await checkResults({ 'changes.outputs.src': src })).not.toBe(0);
    }
  });

  it('rejects each failed required check, including security on docs-only changes', async () => {
    for (const job of gate.needs) {
      expect(await checkResults({ [`${job}.result`]: 'failure' })).not.toBe(0);
    }
    expect(await checkResults({ 'security.result': 'failure', 'changes.outputs.src': 'false' })).not.toBe(0);
  });

  it('requires security, lint, build, and packed consumers for version-only releases', async () => {
    const release = Object.fromEntries(gate.needs.filter(job => job.startsWith('test-') || job === 'sonar-pr')
      .map(job => [`${job}.result`, 'skipped']));
    expect(await checkResults(release)).toBe(0);
    for (const job of ['security', 'lint', 'build', 'packed-consumers']) {
      expect(await checkResults({ ...release, [`${job}.result`]: 'skipped' })).not.toBe(0);
    }
  });
});

function releaseChanges() {
  const manifest = { name: '@enbox/api', version: '0.6.89', dependencies: { '@enbox/agent': 'workspace:*' } };
  const lockfile = {
    lockfileVersion : 1,
    workspaces      : { '': { name: 'enbox' }, 'packages/api': structuredClone(manifest) },
    packages        : { example: ['example@1.0.0', '', {}, 'sha512-integrity'] },
  };
  const nextLockfile = structuredClone(lockfile);
  nextLockfile.workspaces['packages/api'].version = '0.6.90';
  return [
    { path: 'packages/api/package.json', status: 'M', before: JSON.stringify(manifest), after: JSON.stringify({ ...manifest, version: '0.6.90' }) },
    { path: 'bun.lock', status: 'M', before: JSON.stringify(lockfile), after: JSON.stringify(nextLockfile) },
    { path: 'packages/api/CHANGELOG.md', status: 'M', before: '# Changelog', after: '# Changelog\n\n## 0.6.90' },
    { path: '.changeset/example-release.md', status: 'D', before: '---\n"@enbox/api": patch\n---\n\nFix.' },
  ];
}

describe('version-only release detection', () => {
  it('accepts version bumps with matching lockfile metadata, changelogs, and consumed changesets', () => {
    const changes = releaseChanges();
    // Bun lockfiles support comments and trailing commas.
    changes[1].after = changes[1].after.replace('{', '{\n// release metadata\n').replace(/}$/, ',}');
    expect(isReleaseMetadataOnly(changes)).toBe(true);
  });

  it('rejects source, workflow, configuration, new packages, and removed packages', () => {
    for (const [path, status] of [
      ['packages/api/src/index.ts', 'M'], ['.github/workflows/ci.yml', 'M'], ['.changeset/config.json', 'M'],
      ['package.json', 'M'], ['packages/new/package.json', 'A'], ['packages/old/package.json', 'D'],
      ['packages/api/package.json', 'T'], ['.changeset/new-change.md', 'A'], ['packages/api/CHANGELOG.md', 'D'],
    ]) {
      expect(isReleaseMetadataOnly([...releaseChanges(), { path, status }])).toBe(false);
    }
  });

  it('rejects manifest changes beyond the version', () => {
    for (const patch of [
      { dependencies: { '@enbox/agent': '1.0.0' } }, { scripts: { postinstall: 'echo changed' } },
      { exports: './other.js' }, { name: '@enbox/other' }, { version: '0.6.89' }, { version: null },
    ]) {
      const changes = releaseChanges();
      changes[0].after = JSON.stringify({ ...JSON.parse(changes[0].after), ...patch });
      expect(isReleaseMetadataOnly(changes)).toBe(false);
    }
  });

  it('rejects changed resolutions, integrity hashes, dependencies, and unmatched workspace versions', () => {
    for (const mutate of [
      lock => { lock.packages.example[0] = 'example@2.0.0'; },
      lock => { lock.packages.example[3] = 'sha512-changed'; },
      lock => { lock.workspaces['packages/api'].dependencies = {}; },
      lock => { lock.workspaces['packages/api'].version = '0.6.91'; },
      lock => { lock.workspaces['packages/other'] = { version: '1.0.0' }; },
      lock => { lock.overrides = { example: '2.0.0' }; },
      lock => { delete lock.workspaces['packages/api']; },
    ]) {
      const changes = releaseChanges();
      const lockfile = JSON.parse(changes[1].after);
      mutate(lockfile);
      changes[1].after = JSON.stringify(lockfile);
      expect(isReleaseMetadataOnly(changes)).toBe(false);
    }
  });

  it('requires both a manifest bump and matching lockfile changes and rejects malformed JSON', () => {
    expect(isReleaseMetadataOnly([])).toBe(false);
    expect(isReleaseMetadataOnly(releaseChanges().filter(change => change.path !== 'bun.lock'))).toBe(false);
    expect(isReleaseMetadataOnly(releaseChanges().slice(1))).toBe(false);
    for (const index of [0, 1]) {
      const changes = releaseChanges();
      changes[index].after = 'invalid JSON';
      expect(() => isReleaseMetadataOnly(changes)).toThrow();
    }
  });

  it('leaves the source test graph disabled only when per-package detection was skipped', async () => {
    const step = workflow.jobs.changes.steps.find(candidate => candidate.id === 'propagate');
    for (const event of ['pull_request', 'push']) {
      const script = step.run.replaceAll('${{ github.event_name }}', event)
        .replaceAll('${{ steps.src-filter.outputs.src }}', 'true')
        .replace(/\$\{\{ steps\.filter\.outputs\.[\w-]+ \}\}/g, '');
      const directory = await mkdtemp(join(tmpdir(), 'enbox-release-graph-'));
      try {
        const output = join(directory, 'output');
        const child = Bun.spawn(['bash', '-e', '-c', script], {
          env: { ...process.env, GITHUB_OUTPUT: output }, stdout: 'ignore', stderr: 'ignore',
        });
        expect(await child.exited).toBe(0);
        const flags = (await readFile(output, 'utf8')).trim().split('\n');
        expect(flags.length).toBeGreaterThan(10);
        expect(flags.every(flag => flag.endsWith(`=${event === 'push'}`))).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

describe('preinstalled browser runtime', () => {
  it('pins the image and Bun setup to the workspace runtime versions', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const browser = workflow.jobs['test-browser'];
    const prefix = `mcr.microsoft.com/playwright:v${manifest.devDependencies.playwright}-noble@sha256:`;
    expect(browser.container.image.startsWith(prefix)).toBe(true);
    expect(browser.container.image.slice(prefix.length)).toMatch(/^[a-f0-9]{64}$/);
    expect(browser.steps.find(step => step.name === 'Setup Bun').run).toBe(`npm install --global ${manifest.packageManager}`);
  });
});

/** Run the browser step against a command that would pass if incorrectly retried. */
async function runBrowserTests(browser, failFirst) {
  const directory = await mkdtemp(join(tmpdir(), 'enbox-browser-step-'));
  try {
    const calls = join(directory, 'calls');
    const command = join(directory, 'bun');
    await writeFile(command, `#!/usr/bin/env bash
printf '%s %s\\n' "$3" "$4" >> "$BROWSER_CALLS"
if [ "$FAIL_FIRST" = true ] && [ "$3" = '@enbox/common' ] && [ ! -f "$FIRST_FAILURE" ]; then
  touch "$FIRST_FAILURE"
  exit 1
fi
`);
    await chmod(command, 0o755);
    const step = workflow.jobs['test-browser'].steps.find(candidate => candidate.id === 'browser-tests');
    const script = step.run.replaceAll('${{ matrix.browser }}', browser)
      .replaceAll('${{ matrix.shard.packages }}', '@enbox/common @enbox/crypto');
    const child = Bun.spawn(['bash', '-e', '-c', script], {
      env    : {
        ...process.env,
        PATH          : `${directory}:${process.env.PATH}`,
        BROWSER_CALLS : calls,
        FAIL_FIRST    : String(failFirst),
        FIRST_FAILURE : join(directory, 'failed'),
      },
      stdout : 'ignore',
      stderr : 'ignore',
    });
    return { code: await child.exited, calls: (await readFile(calls, 'utf8')).trim().split('\n') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('browser CI failures', () => {
  for (const failFirst of [false, true]) {
    it(failFirst ? 'preserves a failed package while running the remaining packages' : 'accepts successful packages', async () => {
      for (const browser of ['chromium', 'firefox', 'webkit']) {
        const result = await runBrowserTests(browser, failFirst);
        expect(result.code).toBe(failFirst ? 1 : 0);
        const script = browser === 'chromium' ? 'test:browser:coverage' : 'test:browser';
        expect(result.calls).toEqual([`@enbox/common ${script}`, `@enbox/crypto ${script}`]);
      }
    });
  }
});
