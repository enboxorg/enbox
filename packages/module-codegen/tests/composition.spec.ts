import type { TypedModule } from '@enbox/api';

import { generateModuleCode } from '../src/codegen.js';
import { pathToFileURL } from 'node:url';
import { resolveModuleGraph } from '@enbox/dwn-sdk-js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join, relative } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseGenerateArgs, runCheck, runGenerate } from '../src/cli.js';

const BaseDefinition = {
  module    : 'https://example.com/modules/generated-base',
  published : true,
  types     : {
    folder : { dataFormats: ['text/plain'] },
    note   : { dataFormats: ['text/plain'] },
  },
  structure: { folder: { note: {} } },
};

const ConsumerDefinition = {
  module    : 'https://example.com/modules/generated-consumer',
  published : true,
  uses      : { base: BaseDefinition.module },
  types     : {
    comment : { dataFormats: ['text/plain'] },
    local   : { dataFormats: ['text/plain'] },
    note    : { dataFormats: ['application/octet-stream'] },
  },
  structure: {
    note  : { $ref: 'base:folder/note', comment: {} },
    local : { note: {} },
  },
};

const dependency = {
  definition : BaseDefinition,
  importPath : './base.generated.js',
  exportName : 'BaseModule',
};

describe('composition-aware code generation', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(import.meta.dir, '.tmp-composition-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('emits typed imports and runtime metadata with the same resolved identities', async () => {
    const base = await generateModuleCode(BaseDefinition, { schemasDir: directory, moduleName: 'Base' });
    await writeFile(join(directory, 'base.generated.ts'), base.code);
    const consumer = await generateModuleCode(ConsumerDefinition, {
      schemasDir   : directory,
      moduleName   : 'Consumer',
      dependencies : { base: dependency },
    });
    const output = join(directory, 'consumer.generated.ts');
    await writeFile(output, consumer.code);

    const typecheck = Bun.spawn([
      'bun', 'tsc', '--noEmit', '--strict', '--skipLibCheck', '--module', 'ESNext',
      '--moduleResolution', 'Bundler', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable', output,
    ], { stderr: 'pipe', stdout: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(typecheck.stdout).text(),
      new Response(typecheck.stderr).text(),
      typecheck.exited,
    ]);
    expect(exitCode, stdout + stderr).toBe(0);

    const generated = await import(pathToFileURL(output).href) as { ConsumerModule: TypedModule };
    const module = generated.ConsumerModule;
    expect(Object.keys(module.codecs).sort()).toEqual(['comment', 'local', 'note']);
    const graph = resolveModuleGraph(module.definition, uri =>
      Object.values(module.dependencies).find(provider => provider.definition.module === uri)?.definition,
    { requireKeyAgreement: false });
    expect(graph.nodesByDeclaredPath.get('note')).toMatchObject({
      kind             : 'ref',
      owningModuleUri  : BaseDefinition.module,
      owningModulePath : 'folder/note',
    });
    expect(graph.nodesByDeclaredPath.get('note/comment')?.physicalDepth).toBe(3);
    expect(graph.nodesByDeclaredPath.get('local/note')?.recordType.dataFormats)
      .toEqual(['application/octet-stream']);
    expect((await module.codecs.note.encode(new Uint8Array([1, 2]))).dataFormat).toBe('application/octet-stream');
    expect(consumer.code).toContain('dependencies: {');
    expect(consumer.code).not.toContain('from "https://example.com');
  });

  it('rejects missing, extra and mismatched dependency artifacts before emitting code', async () => {
    const options = { schemasDir: directory, moduleName: 'Consumer' };
    await expect(generateModuleCode(ConsumerDefinition, options)).rejects.toThrow('exactly match uses aliases');
    await expect(generateModuleCode(ConsumerDefinition, {
      ...options,
      dependencies: { base: dependency, extra: dependency },
    })).rejects.toThrow('exactly match uses aliases');
    await expect(generateModuleCode(ConsumerDefinition, {
      ...options,
      dependencies: { base: { ...dependency, definition: { ...BaseDefinition, module: 'https://example.com/other' } } },
    })).rejects.toThrow('dependency \'base\' must provide');
  });

  it('uses the local artifact registry for generate and deterministic check', async () => {
    const definition = join(directory, 'consumer.json');
    const registry = join(directory, 'dependencies.json');
    const output = join(directory, 'consumer.generated.ts');
    await writeFile(definition, JSON.stringify(ConsumerDefinition));
    await writeFile(registry, JSON.stringify({ base: dependency }));
    let stderr = '';
    const io = {
      cwd    : directory,
      stderr : { write: (text: string): boolean => { stderr += text; return true; } },
      stdout : { write: (): boolean => true },
    };
    const args = parseGenerateArgs([
      '--definition', relative(directory, definition), '--schemas', '.', '--name', 'Consumer',
      '--dependencies', relative(directory, registry), '--output', relative(directory, output),
    ], io)!;
    await runGenerate(args, io);
    const first = await readFile(output, 'utf-8');
    await runCheck({ ...args, output: args.output! }, io);
    expect(await readFile(output, 'utf-8')).toBe(first);
    expect(stderr).toContain('Up to date:');
  });
});
