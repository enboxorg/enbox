import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

type BrowserArtifact = 'agent' | 'api' | 'auth' | 'browser';

const artifactPaths: Record<BrowserArtifact, string> = {
  agent   : '../../agent/dist/browser.mjs',
  api     : '../../api/dist/browser.mjs',
  auth    : '../../auth/dist/browser.mjs',
  browser : '../dist/browser.mjs',
};

async function readArtifact(artifact: BrowserArtifact): Promise<string> {
  return readFile(new URL(artifactPaths[artifact], import.meta.url), 'utf8');
}

function expectExternalImport(source: string, specifier: string): void {
  expect(source).toMatch(new RegExp(`from["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`));
}

describe('browser bundle artifacts', () => {
  it('keeps first-party package roots external to preserve single class identities', async () => {
    const api = await readArtifact('api');
    const browser = await readArtifact('browser');

    expectExternalImport(api, '@enbox/agent');
    expectExternalImport(api, '@enbox/auth/auth-manager');
    expectExternalImport(browser, '@enbox/api');
    expectExternalImport(browser, '@enbox/auth/browser');

    expect(api).not.toContain('class EnboxUserAgent');
    expect(browser).not.toContain('class EnboxUserAgent');
  });

  it('does not leak Level or Node builtin imports from browser artifacts', async () => {
    for (const artifact of Object.keys(artifactPaths) as BrowserArtifact[]) {
      const source = await readArtifact(artifact);

      expect(source).not.toMatch(/from["']level["']/);
      expect(source).not.toMatch(/from["']events["']/);
      expect(source).not.toMatch(/require\(["']events["']\)/);
      expect(source).not.toContain('process.env');
    }
  });

  it('keeps Node-only password helper imports out of the auth browser artifact', async () => {
    const auth = await readArtifact('auth');

    expectExternalImport(auth, '@enbox/agent');
    expect(auth).not.toContain('node:fs');
    expect(auth).not.toContain('node:child_process');
    expect(auth).not.toContain('fromEnv');
    expect(auth).toContain('fromCallback');
  });
});
