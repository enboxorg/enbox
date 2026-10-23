import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

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
