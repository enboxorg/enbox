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

import type { CodegenResult, CodegenTarget, ProtocolDefinitionInput } from './codegen.js';

import { constants } from 'node:fs';
import { generateProtocolModule } from './codegen.js';
import { parseArgs } from 'node:util';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

const usage = `protocol-codegen <command> [options]

Commands:
  generate  Generate a typed module from a protocol definition and JSON Schemas.
  check     Verify a generated module is present and up to date without writing.

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
      --allow-unresolved  Permit reachable JSON types without local schemas.
      --target      Runtime import target: api or browser. Default: api.
  -h, --help        Show help
`;

const checkUsage = `protocol-codegen check [options]

Options:
  -d, --definition  Path to a JSON file containing the protocol definition.  [required]
  -s, --schemas     Directory containing .json schema files.              [required]
  -n, --name        PascalCase name for the protocol (e.g. Inventory).  [required]
  -o, --output      Generated output file to verify.                    [required]
      --allow-unresolved  Permit reachable JSON types without local schemas.
      --target      Runtime import target: api or browser. Default: api.
  -h, --help        Show help
`;

export type CliIo = {
  cwd: string;
  stderr: { write(chunk: string): boolean };
  stdout: { write(chunk: string): boolean };
};

export type GenerateArgs = {
  allowUnresolvedJsonSchemas? : boolean;
  definition : string;
  name : string;
  output? : string;
  schemas : string;
  target? : CodegenTarget;
};

export type CheckArgs = GenerateArgs & { output: string };

type ParsedOptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export class CliCheckError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliCheckError';
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

function readTargetOption(value: ParsedOptionValues[string]): CodegenTarget | undefined {
  if (value === undefined || value === 'api' || value === 'browser') {
    return value;
  }

  fail(`Invalid target '${String(value)}': expected 'api' or 'browser'.`);
}

function parseCodegenArgs(args: string[], helpText: string, io: CliIo): GenerateArgs | undefined {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals : false,
      options          : {
        'allow-unresolved' : { type: 'boolean' },
        definition         : { type: 'string', short: 'd' },
        help               : { type: 'boolean', short: 'h' },
        name               : { type: 'string', short: 'n' },
        output             : { type: 'string', short: 'o' },
        schemas            : { type: 'string', short: 's' },
        target             : { type: 'string' },
      },
      strict: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to parse arguments.';
    fail(message);
  }

  if (parsed.values.help === true) {
    io.stdout.write(helpText);
    return undefined;
  }

  const target = readTargetOption(parsed.values.target);

  return {
    ...(parsed.values['allow-unresolved'] === true ? { allowUnresolvedJsonSchemas: true } : {}),
    ...(target === undefined ? {} : { target }),
    definition : readRequiredOption(parsed.values, 'definition'),
    name       : readRequiredOption(parsed.values, 'name'),
    output     : typeof parsed.values.output === 'string' ? parsed.values.output : undefined,
    schemas    : readRequiredOption(parsed.values, 'schemas'),
  };
}

export function parseGenerateArgs(args: string[], io: CliIo = defaultIo): GenerateArgs | undefined {
  return parseCodegenArgs(args, generateUsage, io);
}

export function parseCheckArgs(args: string[], io: CliIo = defaultIo): CheckArgs | undefined {
  const parsed = parseCodegenArgs(args, checkUsage, io);
  if (parsed === undefined) {
    return undefined;
  }

  if (parsed.output === undefined) {
    fail('Missing required argument: output');
  }

  return { ...parsed, output: parsed.output };
}

function assertPathWithinCwd(path: string, cwd: string, label: string): void {
  const relativePath = relative(cwd, path);
  const escapesCwd = relativePath === '..' || relativePath.startsWith(`..${sep}`);
  if (!escapesCwd && !isAbsolute(relativePath)) {
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

    try {
      const outputStats = await lstat(outputPath);
      if (outputStats.isSymbolicLink()) {
        fail(`output path must not be a symbolic link: ${outputPath}`);
      }
    } catch (error: unknown) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    return outputPath;
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      throw error;
    }

    fail(`output directory not found: ${dirname(candidatePath)}`);
  }
}

type PreparedGeneration = CodegenResult & { cwd: string };

async function prepareGeneration(args: GenerateArgs, io: CliIo): Promise<PreparedGeneration> {
  const cwd = await resolveCwd(io.cwd);
  const definitionPath = await resolveExistingFilePath(args.definition, cwd, 'definition');
  const schemasDir = await resolveExistingDirectoryPath(args.schemas, cwd, 'schemas');

  // Read the protocol definition JSON.
  const definitionJson = await readFile(definitionPath, 'utf-8');
  const definition = JSON.parse(definitionJson) as ProtocolDefinitionInput;

  const result = await generateProtocolModule(definition, {
    allowUnresolvedJsonSchemas : args.allowUnresolvedJsonSchemas,
    schemasDir,
    protocolName               : args.name,
    target                     : args.target,
  });

  return { ...result, cwd };
}

function reportResolutions(result: CodegenResult, io: CliIo): void {
  for (const [typeName, resolution] of result.resolutions) {
    const icon = resolution.source === 'unresolved' ? '?' : '+';
    io.stderr.write(`  ${icon} ${typeName}: ${resolution.source}\n`);
  }
}

export async function runGenerate(args: GenerateArgs, io: CliIo = defaultIo): Promise<void> {
  const result = await prepareGeneration(args, io);
  reportResolutions(result, io);

  // Write or print.
  if (args.output === undefined) {
    io.stdout.write(result.code);
  } else {
    const outputPath = await resolveOutputFilePath(args.output, result.cwd);
    await writeOutputFile(outputPath, result.code);
    io.stderr.write(`\nWrote ${outputPath}\n`);
  }
}

export async function runCheck(args: CheckArgs, io: CliIo = defaultIo): Promise<void> {
  const result = await prepareGeneration(args, io);
  const outputPath = await resolveOutputFilePath(args.output, result.cwd);
  reportResolutions(result, io);

  let existingCode: string;
  try {
    existingCode = await readOutputFile(outputPath);
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      throw new CliCheckError(`Generated output is missing: ${outputPath}`);
    }
    throw error;
  }

  if (existingCode !== result.code) {
    throw new CliCheckError(`Generated output is stale: ${outputPath}`);
  }

  io.stderr.write(`\nUp to date: ${outputPath}\n`);
}

async function writeOutputFile(outputPath: string, code: string): Promise<void> {
  let output;
  try {
    output = await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    );
  } catch (error: unknown) {
    if (isSymbolicLinkAccessError(error)) {
      fail(`output path must not be a symbolic link: ${outputPath}`);
    }
    throw error;
  }

  try {
    await output.writeFile(code, { encoding: 'utf-8' });
  } finally {
    await output.close();
  }
}

async function readOutputFile(outputPath: string): Promise<string> {
  let output;
  try {
    output = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isSymbolicLinkAccessError(error)) {
      fail(`output path must not be a symbolic link: ${outputPath}`);
    }
    throw error;
  }

  try {
    return await output.readFile({ encoding: 'utf-8' });
  } finally {
    await output.close();
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isSymbolicLinkAccessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP';
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

  if (command === 'generate') {
    const generateArgs = parseGenerateArgs(args, io);
    if (generateArgs !== undefined) {
      await runGenerate(generateArgs, io);
    }
    return;
  }

  if (command === 'check') {
    const checkArgs = parseCheckArgs(args, io);
    if (checkArgs !== undefined) {
      await runCheck(checkArgs, io);
    }
    return;
  }

  fail(`Unknown command: ${command}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}
