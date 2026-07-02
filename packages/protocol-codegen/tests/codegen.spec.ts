import { generateTypes } from '../src/codegen.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { resolveAllSchemas, resolveSchema } from '../src/schema-resolver.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
const SCHEMAS_DIR = join(FIXTURES_DIR, 'schemas');
const SCHEMAS_URI_PATH_DIR = join(FIXTURES_DIR, 'schemas-uri-path');
const PACKAGE_DIR = join(import.meta.dir, '..');

type CliResult = {
  exitCode : number;
  stderr : string;
  stdout : string;
};

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

describe('generateTypes()', () => {
  it('should generate TypeScript types from resolved schemas', async () => {
    const definition = await loadDefinition();

    const { code, resolutions } = await generateTypes(definition as any, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Todo',
    });

    // Should contain auto-generated banner
    expect(code).toContain('Auto-generated by @enbox/protocol-codegen');

    // Should contain type definitions
    expect(code).toContain('export interface ListData');
    expect(code).toContain('export interface TaskData');

    // Should contain Blob type for binary attachment
    expect(code).toContain('export type AttachmentData = Blob;');

    // Should contain SchemaMap
    expect(code).toContain('export type TodoSchemaMap');
    expect(code).toContain('list: ListData;');
    expect(code).toContain('task: TaskData;');
    expect(code).toContain('attachment: AttachmentData;');

    // Resolution metadata should be populated
    expect(resolutions.get('list')!.source).toBe('local-type-name');
    expect(resolutions.get('task')!.source).toBe('local-type-name');
  });

  it('should generate correct interface properties from schema', async () => {
    const definition = await loadDefinition();

    const { code } = await generateTypes(definition as any, {
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

    const { code } = await generateTypes(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Test',
    });

    expect(code).toContain('export type UnknownTypeData = unknown;');
  });

  it('should emit Blob for binary-only types', async () => {
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

    const { code } = await generateTypes(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Media',
    });

    expect(code).toContain('export type AvatarData = Blob;');
    expect(code).toContain('export type MediaSchemaMap');
    expect(code).toContain('avatar: AvatarData;');
  });

  it('should support custom banner comment', async () => {
    const definition = await loadDefinition();

    const { code } = await generateTypes(definition as any, {
      schemasDir    : SCHEMAS_DIR,
      protocolName  : 'Todo',
      bannerComment : '// Custom banner',
    });

    expect(code).toContain('// Custom banner');
    expect(code).not.toContain('Auto-generated');
  });

  it('should support empty banner comment', async () => {
    const definition = await loadDefinition();

    const { code } = await generateTypes(definition as any, {
      schemasDir    : SCHEMAS_DIR,
      protocolName  : 'Todo',
      bannerComment : '',
    });

    expect(code).not.toContain('Auto-generated');
    expect(code.startsWith('//')).toBe(true); // starts with section divider
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

    const { code, resolutions } = await generateTypes(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Mixed',
    });

    // list — resolved from schema
    expect(code).toContain('export interface ListData');
    expect(resolutions.get('list')!.source).toBe('local-type-name');

    // missing — unresolved
    expect(code).toContain('export type MissingData = unknown;');
    expect(resolutions.get('missing')!.source).toBe('unresolved');

    // photo — binary
    expect(code).toContain('export type PhotoData = Blob;');
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

      const { code, resolutions } = await generateTypes(definition, {
        schemasDir   : emptyDir,
        protocolName : 'HttpTest',
      });

      // Schema should have been resolved via HTTP.
      expect(resolutions.get('widget')!.source).toBe('http');

      // Generated code should contain the interface from the HTTP schema.
      expect(code).toContain('export interface WidgetData');
      expect(code).toContain('label: string');
      expect(code).toContain('count?: number');
      expect(code).toContain('export type HttpTestSchemaMap');
      expect(code).toContain('widget: WidgetData;');
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

    const { code } = await generateTypes(definition, {
      schemasDir   : SCHEMAS_DIR,
      protocolName : 'Naming',
    });

    expect(code).toContain('PrivateNoteData');
    expect(code).toContain('HeroImageData');
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
    expect(stdout).toContain('export type TodoSchemaMap');
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
    expect(content).toContain('export type TodoSchemaMap');

    // Clean up
    const { unlinkSync } = await import('node:fs');
    unlinkSync(outputPath);
  });

  it('should exit with error for missing definition file', async () => {
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');

    const proc = Bun.spawn([
      'bun', 'run', cliPath,
      'generate',
      '--definition', '/nonexistent/path.json',
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
