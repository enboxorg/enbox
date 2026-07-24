#!/usr/bin/env bun
/**
 * CLI entry point for `@enbox/protocol-codegen`.
 *
 * Usage:
 *   bunx @enbox/protocol-codegen generate \
 *     --definition ./inventory-definition.json \
 *     --schemas ./schemas/ \
 *     --name Inventory \
 *     --output ./inventory.generated.ts
 *
 * @module
 */

import { generateProtocolModule } from './codegen.js';
import { parseArgs } from 'node:util';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

const usage = `protocol-codegen <command> [options]

Commands:
  generate  Generate a typed module from a protocol definition and JSON Schemas.

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

const generateUsage = `protocol-codegen generate [options]

Options:
  -d, --definition  Path to a JSON file containing the protocol definition.  [required]
  -s, --schemas     Directory containing .json schema files.              [required]
  -n, --name        PascalCase name for the protocol (e.g. Inventory).  [required]
  -o, --output      Output file path. If omitted, prints to stdout.
  -h, --help        Show help
`;

export type CliIo = {
  cwd: string;
  stderr: { write(chunk: string): boolean };
  stdout: { write(chunk: string): boolean };
};

export type GenerateArgs = {
  definition : string;
  name : string;
  output? : string;
  schemas : string;
};

type ParsedOptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const defaultIo: CliIo = {
  cwd    : process.cwd(),
  stderr : process.stderr,
  stdout : process.stdout,
};

function fail(message: string): never {
  throw new CliUsageError(message);
}

function readRequiredOption(values: ParsedOptionValues, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Missing required argument: ${key}`);
  }

  return value;
}

export function parseGenerateArgs(args: string[], io: CliIo = defaultIo): GenerateArgs | undefined {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals : false,
      options          : {
        definition : { type: 'string', short: 'd' },
        help       : { type: 'boolean', short: 'h' },
        name       : { type: 'string', short: 'n' },
        output     : { type: 'string', short: 'o' },
        schemas    : { type: 'string', short: 's' },
      },
      strict: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to parse arguments.';
    fail(message);
  }

  if (parsed.values.help === true) {
    io.stdout.write(generateUsage);
    return undefined;
  }

  return {
    definition : readRequiredOption(parsed.values, 'definition'),
    name       : readRequiredOption(parsed.values, 'name'),
    output     : typeof parsed.values.output === 'string' ? parsed.values.output : undefined,
    schemas    : readRequiredOption(parsed.values, 'schemas'),
  };
}

function assertPathWithinCwd(path: string, cwd: string, label: string): void {
  const relativePath = relative(cwd, path);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return;
  }

  fail(`${label} path must be within the current working directory: ${path}`);
}

async function resolveCwd(cwd: string): Promise<string> {
  const cwdPath = await realpath(cwd);
  const cwdStats = await stat(cwdPath);
  if (!cwdStats.isDirectory()) {
    fail(`current working directory not found: ${cwdPath}`);
  }

  return cwdPath;
}

async function resolveExistingFilePath(inputPath: string, cwd: string, label: string): Promise<string> {
  const candidatePath = resolve(cwd, inputPath);
  assertPathWithinCwd(candidatePath, cwd, label);

  try {
    const filePath = await realpath(candidatePath);
    assertPathWithinCwd(filePath, cwd, label);

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      fail(`${label} file not found: ${filePath}`);
    }

    return filePath;
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      throw error;
    }

    fail(`${label} file not found: ${candidatePath}`);
  }
}

async function resolveExistingDirectoryPath(inputPath: string, cwd: string, label: string): Promise<string> {
  const candidatePath = resolve(cwd, inputPath);
  assertPathWithinCwd(candidatePath, cwd, label);

  try {
    const directoryPath = await realpath(candidatePath);
    assertPathWithinCwd(directoryPath, cwd, label);

    const directoryStats = await stat(directoryPath);
    if (!directoryStats.isDirectory()) {
      fail(`${label} directory not found: ${directoryPath}`);
    }

    return directoryPath;
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      throw error;
    }

    fail(`${label} directory not found: ${candidatePath}`);
  }
}

async function resolveOutputFilePath(inputPath: string, cwd: string): Promise<string> {
  const candidatePath = resolve(cwd, inputPath);
  assertPathWithinCwd(candidatePath, cwd, 'output');

  try {
    const parentPath = await realpath(dirname(candidatePath));
    assertPathWithinCwd(parentPath, cwd, 'output');

    const parentStats = await stat(parentPath);
    if (!parentStats.isDirectory()) {
      fail(`output directory not found: ${parentPath}`);
    }

    const outputPath = resolve(parentPath, basename(candidatePath));
    assertPathWithinCwd(outputPath, cwd, 'output');
    return outputPath;
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      throw error;
    }

    fail(`output directory not found: ${dirname(candidatePath)}`);
  }
}

export async function runGenerate(args: GenerateArgs, io: CliIo = defaultIo): Promise<void> {
  const cwd = await resolveCwd(io.cwd);
  const definitionPath = await resolveExistingFilePath(args.definition, cwd, 'definition');
  const schemasDir = await resolveExistingDirectoryPath(args.schemas, cwd, 'schemas');

  // Read the protocol definition JSON.
  const definitionJson = await readFile(definitionPath, 'utf-8');
  const definition = JSON.parse(definitionJson);

  const { code, resolutions } = await generateProtocolModule(definition, {
    schemasDir,
    protocolName: args.name,
  });

  // Report resolution results to stderr.
  for (const [typeName, resolution] of resolutions) {
    const icon = resolution.source === 'unresolved' ? '?' : '+';
    io.stderr.write(`  ${icon} ${typeName}: ${resolution.source}\n`);
  }

  // Write or print.
  if (args.output === undefined) {
    io.stdout.write(code);
  } else {
    const outputPath = await resolveOutputFilePath(args.output, cwd);
    await writeFile(outputPath, code, 'utf-8');
    io.stderr.write(`\nWrote ${outputPath}\n`);
  }
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<void> {
  const [command, ...args] = argv;

  if (command === '--help' || command === '-h') {
    io.stdout.write(usage);
    return;
  }

  if (command === '--version' || command === '-v') {
    io.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === undefined) {
    fail('You must specify a command.');
  }

  if (command !== 'generate') {
    fail(`Unknown command: ${command}`);
  }

  const generateArgs = parseGenerateArgs(args, io);
  if (generateArgs !== undefined) {
    await runGenerate(generateArgs, io);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exit(1);
    }

    throw error;
  }
}
