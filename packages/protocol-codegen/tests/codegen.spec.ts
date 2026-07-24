import type { CliIo } from '../src/cli.js';

import { generateProtocolModule } from '../src/codegen.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { CliUsageError, main, parseGenerateArgs, runGenerate } from '../src/cli.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolveAllSchemas, resolveSchema } from '../src/schema-resolver.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
const SCHEMAS_DIR = join(FIXTURES_DIR, 'schemas');
const SCHEMAS_URI_PATH_DIR = join(FIXTURES_DIR, 'schemas-uri-path');
const PACKAGE_DIR = join(import.meta.dir, '..');
const TMP_DIR = join(PACKAGE_DIR, '.tmp-codegen-tests');

type CliResult = {
  exitCode : number;
  stderr : string;
  stdout : string;
};

type MemoryCliIo = {
  io : CliIo;
  stderr : () => string;
  stdout : () => string;
};

function createMemoryIo(cwd = PACKAGE_DIR): MemoryCliIo {
  let stderr = '';
  let stdout = '';

  return {
    io: {
      cwd,
      stderr: {
        write: (chunk: string): boolean => {
          stderr += chunk;
          return true;
        },
      },
      stdout: {
        write: (chunk: string): boolean => {
          stdout += chunk;
          return true;
        },
      },
    },
    stderr : (): string => stderr,
    stdout : (): string => stdout,
  };
}

async function loadDefinition(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(FIXTURES_DIR, 'todo-definition.json'), 'utf-8');
  return JSON.parse(raw);
}

async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd    : PACKAGE_DIR,
    env    : process.env,
    stderr : 'pipe',
    stdout : 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('protocol-codegen CLI', () => {
  afterEach(async (): Promise<void> => {
    await rm(TMP_DIR, { force: true, recursive: true });
  });

  it('should parse generate help without running generation', () => {
    const memory = createMemoryIo();

    const result = parseGenerateArgs(['--help'], memory.io);

    expect(result).toBeUndefined();
    expect(memory.stdout()).toContain('protocol-codegen generate [options]');
  });

  it('should parse generate arguments', () => {
    const result = parseGenerateArgs([
      '--definition', join(FIXTURES_DIR, 'todo-definition.json'),
      '--schemas', SCHEMAS_DIR,
      '--name', 'Todo',
      '--output', join(TMP_DIR, 'todo.generated.ts'),
    ], createMemoryIo().io);

    expect(result).toEqual({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      output     : join(TMP_DIR, 'todo.generated.ts'),
      schemas    : SCHEMAS_DIR,
    });
  });

  it('should throw on invalid generate options', () => {
    const memory = createMemoryIo();

    expect(() => parseGenerateArgs(['--invalid'], memory.io)).toThrow(CliUsageError);
  });

  it('should throw on missing generate options', () => {
    const memory = createMemoryIo();

    expect(() => parseGenerateArgs([
      '--definition', join(FIXTURES_DIR, 'todo-definition.json'),
      '--name', 'Todo',
    ], memory.io)).toThrow('Missing required argument: schemas');
  });

  it('should handle top-level help and version in process', async () => {
    const helpMemory = createMemoryIo();
    await main(['--help'], helpMemory.io);
    expect(helpMemory.stdout()).toContain('protocol-codegen <command> [options]');

    const versionMemory = createMemoryIo();
    await main(['--version'], versionMemory.io);
    expect(versionMemory.stdout()).toBe('0.1.0\n');
  });

  it('should throw when no command is provided', async () => {
    const memory = createMemoryIo();

    await expect(main([], memory.io)).rejects.toThrow('You must specify a command.');
  });

  it('should throw when an unknown command is provided', async () => {
    const memory = createMemoryIo();

    await expect(main(['unknown'], memory.io)).rejects.toThrow('Unknown command: unknown');
  });

  it('should throw when generate paths escape the working directory', async () => {
    const memory = createMemoryIo();

    await expect(runGenerate({
      definition : '../package.json',
      name       : 'Todo',
      schemas    : SCHEMAS_DIR,
    }, memory.io)).rejects.toThrow('definition path must be within the current working directory');
  });

  it('should throw when the working directory is not a directory', async () => {
    const memory = createMemoryIo(join(FIXTURES_DIR, 'todo-definition.json'));

    await expect(runGenerate({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      schemas    : SCHEMAS_DIR,
    }, memory.io)).rejects.toThrow('current working directory not found');
  });

  it('should throw when the definition path is not a file', async () => {
    const memory = createMemoryIo();

    await expect(runGenerate({
      definition : FIXTURES_DIR,
      name       : 'Todo',
      schemas    : SCHEMAS_DIR,
    }, memory.io)).rejects.toThrow('definition file not found');
  });

  it('should throw when the schemas path is not a directory', async () => {
    const memory = createMemoryIo();

    await expect(runGenerate({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      schemas    : join(FIXTURES_DIR, 'todo-definition.json'),
    }, memory.io)).rejects.toThrow('schemas directory not found');
  });

  it('should throw when the output directory does not exist', async () => {
    const memory = createMemoryIo();

    await expect(runGenerate({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      output     : join(TMP_DIR, 'missing', 'todo.generated.ts'),
      schemas    : SCHEMAS_DIR,
    }, memory.io)).rejects.toThrow('output directory not found');
  });

  it('should generate TypeScript in process to stdout', async () => {
    const memory = createMemoryIo();

    await runGenerate({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      schemas    : SCHEMAS_DIR,
    }, memory.io);

    expect(memory.stdout()).toContain('export interface ListData');
    expect(memory.stderr()).toContain('+ list: local-type-name');
  });

  it('should generate TypeScript in process to a file', async () => {
    const memory = createMemoryIo();
    await mkdir(TMP_DIR, { recursive: true });

    const output = join(TMP_DIR, 'todo.generated.ts');
    await runGenerate({
      definition : join(FIXTURES_DIR, 'todo-definition.json'),
      name       : 'Todo',
      output,
      schemas    : SCHEMAS_DIR,
    }, memory.io);

    const generated = await readFile(output, 'utf-8');
    expect(generated).toContain('export interface ListData');
    expect(memory.stderr()).toContain(`Wrote ${output}`);
  });

  it('should route generate help through main', async () => {
    const memory = createMemoryIo();

    await main(['generate', '--help'], memory.io);

    expect(memory.stdout()).toContain('protocol-codegen generate [options]');
  });

  it('should print help', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('protocol-codegen <command> [options]');
    expect(result.stdout).toContain('generate');
  });

  it('should print version', async () => {
    const result = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('0.1.0\n');
  });

  it('should fail when required generate flags are missing', async () => {
    const result = await runCli(['generate', '--definition', join(FIXTURES_DIR, 'todo-definition.json'), '--name', 'Todo']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Missing required argument: schemas');
  });

  it('should generate TypeScript to stdout', async () => {
    const result = await runCli([
      'generate',
      '--definition', join(FIXTURES_DIR, 'todo-definition.json'),
      '--schemas', SCHEMAS_DIR,
      '--name', 'Todo',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('export interface ListData');
    expect(result.stderr).toContain('+ list: local-type-name');
  });
});

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

describe('resolveSchema()', () => {
  it('should resolve by type name (strategy 1)', async () => {
    const result = await resolveSchema('list', 'https://example.com/schemas/todo/list', SCHEMAS_DIR);

    expect(result.source).toBe('local-type-name');
    expect(result.schema).toBeDefined();
    expect(result.schema!.title).toBe('ListData');
  });

  it('should resolve by URI path (strategy 2) when type name file is missing', async () => {
    // The schemas-uri-path dir has todo/list.json but NOT list.json at root
    const result = await resolveSchema('list', 'https://example.com/schemas/todo/list', SCHEMAS_URI_PATH_DIR);

    expect(result.source).toBe('local-uri-path');
    expect(result.schema).toBeDefined();
    expect(result.schema!.title).toBe('ListData');
  });

  it('should resolve via HTTP fetch (strategy 3) when local files are missing', async () => {
    // Serve a JSON Schema from a local HTTP server.
    const httpSchema = JSON.stringify({
      $schema    : 'http://json-schema.org/draft-07/schema#',
      type       : 'object',
      properties : { label: { type: 'string' } },
      required   : ['label'],
    });

    const server = Bun.serve({
      port  : 0,
      fetch : () => new Response(httpSchema, {
        headers: { 'content-type': 'application/json' },
      }),
    });

    try {
      // Use a schemas dir with no matching files so local strategies fail.
      const emptyDir = join(FIXTURES_DIR, 'schemas-empty');
      const { mkdirSync, existsSync: dirExists } = await import('node:fs');
      if (!dirExists(emptyDir)) { mkdirSync(emptyDir, { recursive: true }); }

      const result = await resolveSchema(
        'notfound',
        `http://localhost:${server.port}/schemas/widget`,
        emptyDir,
      );

      expect(result.source).toBe('http');
      expect(result.schema).toBeDefined();
      expect(result.schema!.type).toBe('object');
      expect(result.schema!.required).toEqual(['label']);
    } finally {
      server.stop();
    }
  });

  it('should return unresolved when no schema file exists and URI is not fetchable', async () => {
    const result = await resolveSchema(
      'missing',
      'https://example.com/schemas/nonexistent',
      SCHEMAS_DIR,
    );

    expect(result.source).toBe('unresolved');
    expect(result.schema).toBeUndefined();
  });
});

describe('resolveAllSchemas()', () => {
  it('should resolve schemas for all types with schema URIs', async () => {
    const definition = await loadDefinition();
    const types = definition.types as Record<string, { schema?: string }>;

    const results = await resolveAllSchemas(types, SCHEMAS_DIR);

    // list and task should be resolved (have schema files)
    expect(results.has('list')).toBe(true);
    expect(results.get('list')!.source).toBe('local-type-name');

    expect(results.has('task')).toBe(true);
    expect(results.get('task')!.source).toBe('local-type-name');

    // attachment has no schema URI — should not be in the results
    expect(results.has('attachment')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

describe('generateProtocolModule()', () => {
  afterEach(async (): Promise<void> => {
    await rm(TMP_DIR, { force: true, recursive: true });
  });

  it('should generate TypeScript types from resolved schemas', async () => {
    const definition = await loadDefinition();

    const { code, resolutions } = await generateProtocolModule(definition as any, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Todo',
    });

    // Should contain auto-generated banner
    expect(code).toContain('Auto-generated by @enbox/protocol-codegen');

    // Should contain type definitions
    expect(code).toContain('export interface ListData');
    expect(code).toContain('export interface TaskData');

    // Variable MIME attachments retain their MIME type in a Blob.
    expect(code).toContain('export type AttachmentData = Blob;');

    // The complete module wires runtime codecs to the emitted definition.
    expect(code).toContain(`import { defineProtocol, recordCodecs } from '@enbox/api';`);
    expect(code).toContain('export const TodoDefinition = {');
    expect(code).toContain('export const TodoCodecs = {');
    expect(code).toContain('list       : recordCodecs.json<ListData>(),');
    expect(code).toContain('task       : recordCodecs.json<TaskData>(),');
    expect(code).toContain('attachment : recordCodecs.blob(),');
    expect(code).toContain('export const TodoProtocol = defineProtocol(TodoDefinition, TodoCodecs);');
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(code)).not.toThrow();

    const generatedPath = join(TMP_DIR, 'todo.generated.ts');
    await mkdir(TMP_DIR, { recursive: true });
    await Bun.write(generatedPath, code);
    const typecheck = Bun.spawn([
      'bun', 'tsc', '--noEmit', '--strict', '--skipLibCheck',
      '--module', 'ESNext', '--moduleResolution', 'Bundler', '--target', 'ES2022',
      '--lib', 'ES2022,DOM,DOM.Iterable', generatedPath,
    ], { cwd: PACKAGE_DIR, stderr: 'pipe', stdout: 'pipe' });
    const [typecheckOutput, typecheckExitCode] = await Promise.all([
      new Response(typecheck.stderr).text(),
      typecheck.exited,
    ]);
    expect(typecheckExitCode, typecheckOutput).toBe(0);
    // Resolution metadata should be populated
    expect(resolutions.get('list')!.source).toBe('local-type-name');
    expect(resolutions.get('task')!.source).toBe('local-type-name');
  });

  it('should generate correct interface properties from schema', async () => {
    const definition = await loadDefinition();

    const { code } = await generateProtocolModule(definition as any, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Todo',
    });

    // ListData should have name (required) and description (optional)
    expect(code).toContain('name: string');
    expect(code).toContain('description?: string');

    // TaskData should have title, completed (required) and dueDate (optional)
    expect(code).toContain('title: string');
    expect(code).toContain('completed: boolean');
    expect(code).toContain('dueDate?: string');
  });

  it('should emit unknown for unresolved schema types', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/test',
      published : true,
      types     : {
        unknown_type: {
          schema      : 'https://example.com/schemas/nonexistent',
          dataFormats : ['application/json'],
        },
      },
      structure: {
        unknown_type: {},
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Test',
    });

    expect(code).toContain('export type UnknownTypeData = unknown;');
    expect(code).toContain('unknown_type: recordCodecs.json<UnknownTypeData>(),');
  });

  it('should emit Blob for variable binary formats', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/media',
      published : true,
      types     : {
        avatar: {
          dataFormats: ['image/png', 'image/jpeg'],
        },
      },
      structure: {
        avatar: {},
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Media',
    });

    expect(code).toContain('export type AvatarData = Blob;');
    expect(code).toContain('avatar: recordCodecs.blob(),');
  });

  it('should select built-in codecs from declared data formats', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/formats',
      published : true,
      types     : {
        jsonValue: {
          dataFormats: ['application/merge-patch+json'],
        },
        plainText: {
          dataFormats: ['text/plain'],
        },
        markdown: {
          dataFormats: ['text/markdown'],
        },
        bytes: {
          dataFormats: ['application/octet-stream'],
        },
        image: {
          dataFormats: ['image/png'],
        },
        media: {
          dataFormats: ['image/png', 'image/jpeg'],
        },
        styledText: {
          dataFormats: ['text/plain', 'text/markdown'],
        },
      },
      structure: {
        jsonValue  : {},
        plainText  : {},
        markdown   : {},
        bytes      : {},
        image      : {},
        media      : {},
        styledText : {},
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Formats',
    });

    expect(code).toContain('export type JsonValueData = unknown;');
    expect(code).toContain('export type PlainTextData = string;');
    expect(code).toContain('export type MarkdownData = string;');
    expect(code).toContain('export type BytesData = Uint8Array;');
    expect(code).toContain('export type ImageData = Uint8Array;');
    expect(code).toContain('export type MediaData = Blob;');
    expect(code).toContain('export type StyledTextData = Blob;');
    expect(code).toContain('jsonValue  : recordCodecs.json<JsonValueData>("application/merge-patch+json"),');
    expect(code).toContain('plainText  : recordCodecs.text(),');
    expect(code).toContain('markdown   : recordCodecs.text("text/markdown"),');
    expect(code).toContain('bytes      : recordCodecs.bytes(),');
    expect(code).toContain('image      : recordCodecs.bytes("image/png"),');
    expect(code).toContain('media      : recordCodecs.blob(),');
    expect(code).toContain('styledText : recordCodecs.blob(),');
  });

  it('should derive representation from MIME formats rather than schema presence', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/schema-formats',
      published : true,
      types     : {
        label: {
          schema      : 'https://example.com/schemas/task',
          dataFormats : ['text/plain'],
        },
        binary: {
          schema      : 'https://example.com/schemas/task',
          dataFormats : ['application/cbor'],
        },
        mixed: {
          schema      : 'https://example.com/schemas/task',
          dataFormats : ['application/json', 'text/plain'],
        },
      },
      structure: {
        label  : {},
        binary : {},
        mixed  : {},
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'SchemaFormats',
    });

    expect(code).toContain('export type LabelData = string;');
    expect(code).toContain('export type BinaryData = Uint8Array;');
    expect(code).toContain('export type MixedData = Blob;');
    expect(code).toContain('label  : recordCodecs.text(),');
    expect(code).toContain('binary : recordCodecs.bytes("application/cbor"),');
    expect(code).toContain('mixed  : recordCodecs.blob(),');
  });

  it('should reject $ref paths until referenced protocol metadata can be supplied', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/composed',
      published : true,
      uses      : { threads: 'https://example.com/protocols/threads' },
      types     : {
        comment: { dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $ref    : 'threads:thread',
          comment : {},
        },
      },
    };

    await expect(generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Composed',
    })).rejects.toThrow('Cannot generate a typed codec for $ref path \'thread\'');
  });

  it('should preserve the complete protocol definition and its directives', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/complete',
      published : true,
      uses      : { social: 'https://example.com/protocols/social' },
      types     : {
        note: {
          dataFormats        : ['application/json'],
          encryptionRequired : true,
        },
      },
      structure: {
        note: {
          $recordLimit : { max: 1 },
          $size        : { max: 4096 },
          $tags        : {
            $requiredTags       : ['topic'],
            $allowUndefinedTags : false,
            topic               : { type: 'string' },
          },
          $actions: [
            { who: 'anyone', can: ['create'] },
          ],
        },
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Complete',
    });

    expect(code).toContain('uses      : {');
    expect(code).toContain('social: "https://example.com/protocols/social",');
    expect(code).toContain('encryptionRequired : true,');
    expect(code).toContain('$recordLimit: {');
    expect(code).toContain('$size: {');
    expect(code).toContain('$tags: {');
    expect(code).toContain('$actions: [');
    expect(code).toContain('as const satisfies ProtocolDefinition;');
  });

  it('should encode arbitrary definition strings as safe TypeScript literals', async () => {
    const hostileFormat = 'application/x-test\'; globalThis.compromised = true; //"\\\n\0';
    const definition = {
      protocol  : 'https://example.com/protocols/string-escaping',
      published : true,
      types     : {
        note: { dataFormats: [hostileFormat] },
      },
      structure: { note: {} },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'StringEscaping',
    });

    expect(code).toContain(JSON.stringify(hostileFormat));
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(code)).not.toThrow();
  });

  it('should fail when a reachable type has no usable codec metadata', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/missing-codec',
      published : true,
      types     : { note: {} },
      structure : { note: {} },
    };

    await expect(generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'MissingCodec',
    })).rejects.toThrow('Cannot infer a record codec for protocol type \'note\'');
  });

  it('should emit codecs only for types reachable through the structure', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/reachable',
      published : true,
      types     : {
        note   : { dataFormats: ['application/json'] },
        unused : {},
      },
      structure: { note: {} },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Reachable',
    });

    expect(code).toContain('export type UnusedData = unknown;');
    expect(code).toContain('export const ReachableCodecs = {\n  note: recordCodecs.json<NoteData>(),\n} as const;');
    expect(code).not.toContain('unused: recordCodecs.');
  });

  it('should support custom banner comment', async () => {
    const definition = await loadDefinition();

    const { code } = await generateProtocolModule(definition as any, {
      schemasDir    : SCHEMAS_DIR,
      protocolName  : 'Todo',
      bannerComment : '// Custom banner',
    });

    expect(code).toContain('// Custom banner');
    expect(code).not.toContain('Auto-generated');
  });

  it('should support empty banner comment', async () => {
    const definition = await loadDefinition();

    const { code } = await generateProtocolModule(definition as any, {
      schemasDir    : SCHEMAS_DIR,
      protocolName  : 'Todo',
      bannerComment : '',
    });

    expect(code).not.toContain('Auto-generated');
    expect(code.startsWith('import type { ProtocolDefinition }')).toBe(true);
  });

  it('should handle mixed resolved and unresolved types', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/mixed',
      published : true,
      types     : {
        list: {
          schema      : 'https://example.com/schemas/todo/list',
          dataFormats : ['application/json'],
        },
        missing: {
          schema      : 'https://example.com/schemas/nonexistent',
          dataFormats : ['application/json'],
        },
        photo: {
          dataFormats: ['image/png'],
        },
      },
      structure: {
        list    : {},
        missing : {},
        photo   : {},
      },
    };

    const { code, resolutions } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Mixed',
    });

    // list — resolved from schema
    expect(code).toContain('export interface ListData');
    expect(resolutions.get('list')!.source).toBe('local-type-name');

    // missing — unresolved
    expect(code).toContain('export type MissingData = unknown;');
    expect(resolutions.get('missing')!.source).toBe('unresolved');

    // photo — one fixed binary MIME type
    expect(code).toContain('export type PhotoData = Uint8Array;');
    expect(code).toContain('photo   : recordCodecs.bytes("image/png"),');
  });

  it('should generate types from HTTP-resolved schemas', async () => {
    // Serve a schema without a `title` field so json-schema-to-typescript
    // uses the type name we provide (WidgetData).
    const httpSchema = JSON.stringify({
      $schema              : 'http://json-schema.org/draft-07/schema#',
      type                 : 'object',
      properties           : { label: { type: 'string' }, count: { type: 'number' } },
      required             : ['label'],
      additionalProperties : false,
    });

    const server = Bun.serve({
      port  : 0,
      fetch : () => new Response(httpSchema, {
        headers: { 'content-type': 'application/json' },
      }),
    });

    try {
      const emptyDir = join(FIXTURES_DIR, 'schemas-empty');
      const { mkdirSync, existsSync: dirExists } = await import('node:fs');
      if (!dirExists(emptyDir)) { mkdirSync(emptyDir, { recursive: true }); }

      const definition = {
        protocol  : 'https://example.com/protocols/http-test',
        published : true,
        types     : {
          widget: {
            schema      : `http://localhost:${server.port}/schemas/widget`,
            dataFormats : ['application/json'],
          },
        },
        structure: {
          widget: {},
        },
      };

      const { code, resolutions } = await generateProtocolModule(definition, {
        schemasDir   : emptyDir,
        protocolName : 'HttpTest',
      });

      // Schema should have been resolved via HTTP.
      expect(resolutions.get('widget')!.source).toBe('http');

      // Generated code should contain the interface from the HTTP schema.
      expect(code).toContain('export interface WidgetData');
      expect(code).toContain('label: string');
      expect(code).toContain('count?: number');
      expect(code).toContain('widget: recordCodecs.json<WidgetData>(),');
      expect(code).toContain('export const HttpTestProtocol = defineProtocol(HttpTestDefinition, HttpTestCodecs);');
    } finally {
      server.stop();
    }
  });

  it('should PascalCase type names correctly', async () => {
    const definition = {
      protocol  : 'https://example.com/protocols/naming',
      published : true,
      types     : {
        'private-note': {
          schema      : 'https://example.com/schemas/nonexistent',
          dataFormats : ['application/json'],
        },
        hero_image: {
          dataFormats: ['image/png'],
        },
      },
      structure: {
        'private-note' : {},
        hero_image     : {},
      },
    };

    const { code } = await generateProtocolModule(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Naming',
    });

    expect(code).toContain('PrivateNoteData');
    expect(code).toContain('HeroImageData');
    expect(code).toContain('"private-note" : recordCodecs.json<PrivateNoteData>(),');
    expect(code).toContain('hero_image     : recordCodecs.bytes("image/png"),');
  });
});

// ---------------------------------------------------------------------------
// CLI (integration test via subprocess)
// ---------------------------------------------------------------------------

describe('CLI', () => {
  it('should generate types and write to stdout', async () => {
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
    const definitionPath = join(FIXTURES_DIR, 'todo-definition.json');

    const proc = Bun.spawn([
      'bun', 'run', cliPath,
      'generate',
      '--definition', definitionPath,
      '--schemas', SCHEMAS_DIR,
      '--name', 'Todo',
    ], {
      stdout : 'pipe',
      stderr : 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('export interface ListData');
    expect(stdout).toContain('export const TodoCodecs');
    expect(stdout).toContain('export const TodoProtocol = defineProtocol(TodoDefinition, TodoCodecs);');
    expect(stderr).toContain('list: local-type-name');
    expect(stderr).toContain('task: local-type-name');
  });

  it('should generate types and write to a file', async () => {
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
    const definitionPath = join(FIXTURES_DIR, 'todo-definition.json');
    const outputPath = join(FIXTURES_DIR, '__output__.generated.ts');

    const proc = Bun.spawn([
      'bun', 'run', cliPath,
      'generate',
      '--definition', definitionPath,
      '--schemas', SCHEMAS_DIR,
      '--name', 'Todo',
      '--output', outputPath,
    ], {
      stdout : 'pipe',
      stderr : 'pipe',
    });

    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // Verify the file was written
    const content = await readFile(outputPath, 'utf-8');
    expect(content).toContain('export interface ListData');
    expect(content).toContain('export const TodoCodecs');
    expect(content).toContain('export const TodoProtocol = defineProtocol(TodoDefinition, TodoCodecs);');

    // Clean up
    const { unlinkSync } = await import('node:fs');
    unlinkSync(outputPath);
  });

  it('should exit with error for missing definition file', async () => {
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');

    const proc = Bun.spawn([
	      'bun', 'run', cliPath,
	      'generate',
	      '--definition', join(FIXTURES_DIR, 'missing-definition.json'),
	      '--schemas', SCHEMAS_DIR,
	      '--name', 'Test',
    ], {
      stdout : 'pipe',
      stderr : 'pipe',
    });

    await proc.exited;
    expect(proc.exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain('not found');
  });
});
