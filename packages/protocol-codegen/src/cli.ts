#!/usr/bin/env bun
/**
 * CLI entry point for `@enbox/protocol-codegen`.
 *
 * Usage:
 *   bunx @enbox/protocol-codegen generate \
 *     --definition ./social-graph-definition.json \
 *     --schemas ./schemas/ \
 *     --name SocialGraph \
 *     --output ./social-graph.generated.ts
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { generateTypes } from './codegen.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

const usage = `protocol-codegen <command> [options]

Commands:
  generate  Generate TypeScript types from a protocol definition and JSON Schemas.

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

const generateUsage = `protocol-codegen generate [options]

Options:
  -d, --definition  Path to a JSON file containing the protocol definition.  [required]
  -s, --schemas     Directory containing .json schema files.              [required]
  -n, --name        PascalCase name for the protocol (e.g. SocialGraph).  [required]
  -o, --output      Output file path. If omitted, prints to stdout.
  -h, --help        Show help
`;

type GenerateArgs = {
  definition : string;
  name : string;
  output? : string;
  schemas : string;
};

type ParsedOptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

function printError(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function readRequiredOption(values: ParsedOptionValues, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value.length === 0) {
    printError(`Missing required argument: ${key}`);
  }

  return value;
}

function parseGenerateArgs(args: string[]): GenerateArgs | undefined {
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
    printError(message);
  }

  if (parsed.values.help === true) {
    process.stdout.write(generateUsage);
    return undefined;
  }

  return {
    definition : readRequiredOption(parsed.values, 'definition'),
    name       : readRequiredOption(parsed.values, 'name'),
    output     : typeof parsed.values.output === 'string' ? parsed.values.output : undefined,
    schemas    : readRequiredOption(parsed.values, 'schemas'),
  };
}

async function runGenerate(args: GenerateArgs): Promise<void> {
  const definitionPath = resolve(args.definition);
  const schemasDir = resolve(args.schemas);

  if (!existsSync(definitionPath)) {
    printError(`definition file not found: ${definitionPath}`);
  }

  if (!existsSync(schemasDir)) {
    printError(`schemas directory not found: ${schemasDir}`);
  }

  // Read the protocol definition JSON.
  const definitionJson = await readFile(definitionPath, 'utf-8');
  const definition = JSON.parse(definitionJson);

  const { code, resolutions } = await generateTypes(definition, {
    schemasDir,
    protocolName: args.name,
  });

  // Report resolution results to stderr.
  for (const [typeName, resolution] of resolutions) {
    const icon = resolution.source === 'unresolved' ? '?' : '+';
    process.stderr.write(`  ${icon} ${typeName}: ${resolution.source}\n`);
  }

  // Write or print.
  if (args.output === undefined) {
    process.stdout.write(code);
  } else {
    const outputPath = resolve(args.output);
    await writeFile(outputPath, code, 'utf-8');
    process.stderr.write(`\nWrote ${outputPath}\n`);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === undefined) {
    printError('You must specify a command.');
  }

  if (command !== 'generate') {
    printError(`Unknown command: ${command}`);
  }

  const generateArgs = parseGenerateArgs(args);
  if (generateArgs !== undefined) {
    await runGenerate(generateArgs);
  }
}

await main(process.argv.slice(2));
