import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
