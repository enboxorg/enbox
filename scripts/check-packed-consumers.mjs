#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));

async function run(args, cwd, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${args.join(' ')} failed (${code}):\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

function exportTargets(value) {
  if (typeof value === 'string') {
    return [value];
  }
  return Object.values(value ?? {}).flatMap(exportTargets);
}

async function pack(directory) {
  const bin = join(directory, 'bin');
  const artifacts = join(directory, 'artifacts');
  await mkdir(bin);
  await mkdir(artifacts);
  const head = await run(['git', 'rev-parse', '--verify', 'HEAD'], root);
  // The real publisher packs and restores manifests; external writes are captured locally.
  await writeFile(join(bin, 'npm'), `#!/usr/bin/env bash
set -eu
case "$1" in
  view) exit 1 ;;
  publish) cp -- "$2" "$PACKED_ARTIFACT_DIR/" ;;
  *) exit 99 ;;
esac
`);
  await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
set -eu
case "$1" in
  rev-parse) printf '%s\\n' "$PACKED_GIT_HEAD" ;;
  ls-remote) exit 2 ;;
  show-ref) exit 1 ;;
  tag) exit 0 ;;
  *) exit 99 ;;
esac
`);
  await Promise.all(['npm', 'git'].map(name => chmod(join(bin, name), 0o755)));
  const env = {
    ...process.env,
    PATH                : `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    PACKED_ARTIFACT_DIR  : artifacts,
    PACKED_GIT_HEAD      : head,
    CHANGESETS_OUTPUT   : join(directory, 'receipts.ndjson'),
  };
  await run(['bash', 'scripts/publish.sh'], root, env);

  const packages = new Map();
  for (const file of await readdir(artifacts)) {
    const tarball = join(artifacts, file);
    const pkg = JSON.parse(await run(['tar', '-xOf', tarball, 'package/package.json'], root));
    const names = (await run(['tar', '-tf', tarball], root)).split('\n');
    const targets = [pkg.exports, pkg.bin, ...['main', 'module', 'types', 'browser'].map(key => pkg[key])]
      .flatMap(exportTargets);
    for (const target of targets) {
      assert(names.some(name => new Bun.Glob(`package/${target.replace(/^\.\//, '')}`).match(name)),
        `${pkg.name}: missing package entry ${target}`);
    }
    assert.equal(pkg.gitHead, head, `${pkg.name}: missing release commit identity`);
    packages.set(pkg.name, { ...pkg, tarball });
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const workspace of manifest.workspaces) {
    const source = JSON.parse(await readFile(join(root, workspace, 'package.json'), 'utf8'));
    if (source.private !== true) {
      assert.equal(packages.get(source.name)?.version, source.version, `missing or stale package ${source.name}`);
    }
  }
  for (const pkg of packages.values()) {
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const [name, version] of Object.entries(pkg[kind] ?? {})) {
        assert(!version.startsWith('workspace:'), `${pkg.name}: unresolved ${name}`);
        if (packages.has(name)) {
          assert.equal(version, packages.get(name).version, `${pkg.name}: stale internal dependency ${name}`);
        }
      }
    }
  }
  return packages;
}

async function consumer(directory, name, targets, packages, devDependencies = {}) {
  const cwd = join(directory, name);
  await mkdir(cwd);
  const overrides = Object.fromEntries([...packages].map(([key, value]) => [key, `file:${value.tarball}`]));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name         : `packed-${name}`,
    private      : true,
    type         : 'module',
    dependencies : Object.fromEntries(targets.map(target => [target, overrides[target]])),
    devDependencies,
    overrides,
  }, null, 2));
  await run([process.execPath, 'install', '--ignore-scripts'], cwd);
  return cwd;
}

async function checkClient(directory, packages) {
  const api = packages.get('@enbox/api');
  const cwd = await consumer(directory, 'client', ['@enbox/api', '@enbox/browser', '@enbox/protocols'], packages, {
    typescript    : api.devDependencies.typescript,
    '@types/node' : api.devDependencies['@types/node'],
  });
  await copyFile(new URL('./fixtures/packed-client.mjs', import.meta.url), join(cwd, 'smoke.mjs'));
  await run(['node', 'smoke.mjs'], cwd);
  await run([process.execPath, 'smoke.mjs'], cwd);
  const typeTests = join(cwd, 'type-tests');
  await mkdir(typeTests);
  for (const file of await readdir(join(root, 'packages/api/type-tests'))) {
    if (file.endsWith('.ts')) {
      await copyFile(join(root, 'packages/api/type-tests', file), join(typeTests, file));
    }
  }
  await copyFile(join(root, 'packages/browser/type-tests/dom.ts'), join(typeTests, 'browser-dom.ts'));
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target           : 'ES2022',
      module           : 'NodeNext',
      moduleResolution : 'NodeNext',
      lib              : ['DOM', 'ES2022'],
      types            : ['node'],
      strict           : true,
      skipLibCheck     : false,
      noEmit           : true,
      esModuleInterop  : true,
    },
    include: ['type-tests/*.ts'],
  }));
  for (const exact of ['false', 'true']) {
    await run(['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--exactOptionalPropertyTypes', exact], cwd);
  }
  await copyFile(new URL('./fixtures/packed-browser.mjs', import.meta.url), join(cwd, 'browser.mjs'));
  await build({ absWorkingDir: cwd, entryPoints: ['browser.mjs'], bundle: true, platform: 'browser', format: 'esm', outfile: 'bundle.mjs' });
}

async function checkServer(directory, packages) {
  const cwd = await consumer(directory, 'server', ['@enbox/dwn-server', '@enbox/local-node'], packages);
  // Reserve an ephemeral port, then verify the real executable chooses its own runtime.
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const data = `level://${join(cwd, 'data')}`;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DWN_') && !key.startsWith('DS_'))),
    PATH                        : `${dirname(process.execPath)}:${process.env.PATH}`,
    DS_HOST                     : '127.0.0.1',
    DS_PORT                     : String(port),
    DWN_BASE_URL                : `http://127.0.0.1:${port}`,
    DWN_SERVER_PACKAGE_NAME     : 'packed-consumer-fixture',
    DWN_SERVER_LOG_LEVEL        : 'ERROR',
    DWN_STORAGE_MESSAGES        : data,
    DWN_STORAGE_DATA            : data,
    DWN_STORAGE_RESUMABLE_TASKS : data,
    DWN_TTL_CACHE_URL           : 'sqlite://',
  };
  const child = Bun.spawn([join(cwd, 'node_modules/.bin/dwn-server')], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    let info;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          info = await response.json();
          break;
        }
      } catch {
        // The child has not bound its socket yet.
      }
      await Bun.sleep(100);
    }
    if (info === undefined) {
      throw new Error('packed server did not start with its installed executable');
    }
    assert.equal(info.server, 'packed-consumer-fixture');
    assert.equal(info.version, packages.get('@enbox/dwn-server').version);
    assert.equal(info.sdkVersion, packages.get('@enbox/dwn-sdk-js').version);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(3_000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await child.exited;
    const logs = await output;
    if (child.exitCode !== 0 && child.exitCode !== 143) {
      console.error(logs.join('\n'));
    }
  }
  const help = await run([join(cwd, 'node_modules/.bin/enbox-local-node'), '--help'], cwd, env);
  assert(help.includes('Usage: enbox-local-node'));
}

async function checkCli(directory, packages) {
  const cwd = await consumer(directory, 'cli', ['@enbox/cli', '@enbox/protocol-codegen'], packages);
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const version = await run([join(cwd, 'node_modules/.bin/protocol-codegen'), '--version'], cwd, env);
  assert.equal(version, packages.get('@enbox/protocol-codegen').version);
}

const directory = await mkdtemp(join(tmpdir(), 'enbox-packed-consumers-'));
try {
  const packages = await pack(directory);
  await checkClient(directory, packages);
  await checkServer(directory, packages);
  await checkCli(directory, packages);
  console.log(`Verified ${packages.size} packed packages, strict declarations, browser bundling, and installed executables.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
