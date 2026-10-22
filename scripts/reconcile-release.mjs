#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function run(args, input) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: input === undefined ? 'ignore' : 'pipe' });
  if (input !== undefined) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

async function checked(args, input) {
  const result = await run(args, input);
  if (result.code !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function getRelease(endpoint) {
  const result = await run(['gh', 'api', endpoint]);
  if (result.code !== 0) {
    if (/HTTP 404/.test(result.stderr)) {
      return undefined;
    }
    throw new Error(`reading GitHub release failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function assertRelease(release, tag) {
  if (release.tag_name !== tag || release.draft !== false) {
    throw new Error(`GitHub release for ${tag} has an unexpected tag or is still a draft`);
  }
}

async function reconcileGitHubRelease(repo, tag, version, body) {
  const endpoint = `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const existing = await getRelease(endpoint);
  if (existing !== undefined) {
    assertRelease(existing, tag);
    return;
  }
  const created = await run(['gh', 'api', `repos/${repo}/releases`, '-X', 'POST', '--input', '-'], JSON.stringify({
    tag_name   : tag,
    name       : tag,
    body,
    prerelease : version.includes('-'),
  }));
  if (created.code === 0) {
    assertRelease(JSON.parse(created.stdout), tag);
    return;
  }
  // A concurrent request or a lost POST response may already have created it.
  const recovered = await getRelease(endpoint);
  if (recovered === undefined) {
    throw new Error(`creating GitHub release ${tag} failed: ${created.stderr}`);
  }
  assertRelease(recovered, tag);
}

async function reconcileTag(tag, head) {
  const ref = `refs/tags/${tag}`;
  const remote = await run(['git', 'ls-remote', '--exit-code', '--refs', 'origin', ref]);
  if (remote.code === 0) {
    await checked(['git', 'fetch', '--no-tags', 'origin', `${ref}:${ref}`]);
  } else if (remote.code !== 2) {
    throw new Error(`reading remote tag ${tag} failed: ${remote.stderr}`);
  }
  const local = await run(['git', 'show-ref', '--verify', '--quiet', ref]);
  if (local.code === 0) {
    const taggedCommit = await checked(['git', 'rev-parse', '--verify', `${ref}^{commit}`]);
    if (taggedCommit !== head) {
      throw new Error(`tag ${tag} points to a different commit`);
    }
  } else if (local.code === 1) {
    await checked(['git', 'tag', '-a', tag, '-m', tag]);
  } else {
    throw new Error(`reading local tag ${tag} failed: ${local.stderr}`);
  }
  if (remote.code === 2) {
    await checked(['git', 'push', 'origin', ref]);
  }
}

async function releaseNotes(directory, version) {
  const lines = (await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8')).split(/\r?\n/);
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) {
    throw new Error(`missing changelog entry for ${directory}@${version}`);
  }
  const next = lines.findIndex((line, index) => index > start && /^## \d+\.\d+\.\d+(?:[-+]\S+)?$/.test(line));
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n').trim();
}

/** Reconcile only releases whose registry metadata proves they came from this commit. */
export async function reconcileRelease() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error('GITHUB_REPOSITORY must identify the release repository');
  }
  const head = await checked(['git', 'rev-parse', '--verify', 'HEAD']);
  const parent = await checked(['git', 'rev-parse', '--verify', 'HEAD^']);
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  const failures = [];
  for (const workspace of root.workspaces) {
    for await (const manifest of new Bun.Glob(`${workspace}/package.json`).scan({ onlyFiles: true })) {
      const pkg = JSON.parse(await readFile(manifest, 'utf8'));
      if (pkg.private === true) {
        continue;
      }
      const tag = `${pkg.name}@${pkg.version}`;
      try {
        const previous = await run(['git', 'show', `${parent}:${manifest}`]);
        const changedVersion = previous.code !== 0 || JSON.parse(previous.stdout).version !== pkg.version;
        const published = JSON.parse(await checked(['npm', 'view', tag, '--json', '--prefer-online']));
        if (published.name !== pkg.name || published.version !== pkg.version) {
          throw new Error(`registry returned mismatched package metadata for ${tag}`);
        }
        if (published.gitHead !== head) {
          if (changedVersion) {
            throw new Error(`${tag} was not published from release commit ${head}`);
          }
          // Historical versions are outside this release, including legacy versions without gitHead.
          continue;
        }
        const directory = resolve(manifest, '..');
        const notes = await releaseNotes(directory, pkg.version);
        await reconcileTag(tag, head);
        await reconcileGitHubRelease(repo, tag, pkg.version, notes);
        console.log(`Reconciled ${tag} at ${head}`);
      } catch (error) {
        failures.push(`${tag}: ${error.message}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

if (import.meta.main) {
  await reconcileRelease();
}
