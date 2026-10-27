import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

/** Only Changesets release metadata may bypass the source test suites. */
export function isReleaseMetadataOnly(changes) {
  const versions = new Map();
  let lockfile;

  for (const { path, status, before, after } of changes) {
    if (/^packages\/[^/]+\/package\.json$/.test(path) && status === 'M') {
      const previous = JSON.parse(before);
      const next = JSON.parse(after);
      const version = /^\d+\.\d+\.\d+$/;
      if (!version.test(previous.version) || !version.test(next.version) || previous.version === next.version) {
        return false;
      }
      versions.set(path.slice(0, -'/package.json'.length), { before: previous.version, after: next.version });
      delete previous.version;
      delete next.version;
      if (!isDeepStrictEqual(previous, next)) {
        return false;
      }
    } else if (path === 'bun.lock' && status === 'M') {
      lockfile = { before, after };
    } else if (/^packages\/[^/]+\/CHANGELOG\.md$/.test(path) && ['A', 'M'].includes(status)) {
      continue;
    } else if (/^\.changeset\/[a-z0-9-]+\.md$/.test(path) && status === 'D') {
      continue;
    } else {
      return false;
    }
  }

  if (versions.size === 0 || !lockfile) {
    return false;
  }

  const previous = Bun.JSONC.parse(lockfile.before);
  const next = Bun.JSONC.parse(lockfile.after);
  for (const [workspace, version] of versions) {
    if (previous.workspaces?.[workspace]?.version !== version.before || next.workspaces?.[workspace]?.version !== version.after) {
      return false;
    }
    previous.workspaces[workspace].version = version.after;
  }
  // Resolutions, integrity hashes, dependencies, and every other field must match.
  return isDeepStrictEqual(previous, next);
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (![base, head].every(ref => /^[a-f0-9]{40}$/.test(ref ?? ''))) {
    throw new Error('expected base and head commit SHAs');
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const fields = git('diff', '--no-renames', '--name-status', '-z', base, head, '--').split('\0');
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, path] = fields.slice(index, index + 2);
    const compareContents = status === 'M' && (path === 'bun.lock' || /^packages\/[^/]+\/package\.json$/.test(path));
    changes.push({
      path,
      status,
      before : compareContents ? git('show', `${base}:${path}`) : undefined,
      after  : compareContents ? git('show', `${head}:${path}`) : undefined,
    });
  }
  console.log(`only=${isReleaseMetadataOnly(changes)}`);
}
