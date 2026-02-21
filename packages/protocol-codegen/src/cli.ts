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

import yargs from 'yargs';

import { existsSync } from 'node:fs';
import { generateTypes } from './codegen.js';
import { hideBin } from 'yargs/helpers';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cli = yargs(hideBin(process.argv))
  .scriptName('protocol-codegen')
  .usage('$0 <command> [options]')
  .help('help').alias('help', 'h')
  .version('version', '0.1.0').alias('version', 'v')
  .strict()
  .demandCommand(1, 'You must specify a command.')
  .command(
    'generate',
    'Generate TypeScript types from a protocol definition and JSON Schemas.',
    (y) => {
      return y
        .option('definition', {
          alias        : 'd',
          describe     : 'Path to a JSON file containing the protocol definition.',
          type         : 'string',
          demandOption : true,
        })
        .option('schemas', {
          alias        : 's',
          describe     : 'Directory containing .json schema files.',
          type         : 'string',
          demandOption : true,
        })
        .option('name', {
          alias        : 'n',
          describe     : 'PascalCase name for the protocol (e.g. SocialGraph).',
          type         : 'string',
          demandOption : true,
        })
        .option('output', {
          alias    : 'o',
          describe : 'Output file path. If omitted, prints to stdout.',
          type     : 'string',
        });
    },
    async (args) => {
      const definitionPath = resolve(args.definition);
      const schemasDir = resolve(args.schemas);

      if (!existsSync(definitionPath)) {
        process.stderr.write(`Error: definition file not found: ${definitionPath}\n`);
        process.exit(1);
      }

      if (!existsSync(schemasDir)) {
        process.stderr.write(`Error: schemas directory not found: ${schemasDir}\n`);
        process.exit(1);
      }

      // Read the protocol definition JSON
      const definitionJson = await readFile(definitionPath, 'utf-8');
      const definition = JSON.parse(definitionJson);

      const { code, resolutions } = await generateTypes(definition, {
        schemasDir,
        protocolName: args.name,
      });

      // Report resolution results to stderr
      for (const [typeName, resolution] of resolutions) {
        const icon = resolution.source === 'unresolved' ? '?' : '+';
        process.stderr.write(`  ${icon} ${typeName}: ${resolution.source}\n`);
      }

      // Write or print
      if (args.output !== undefined) {
        const outputPath = resolve(args.output);
        await writeFile(outputPath, code, 'utf-8');
        process.stderr.write(`\nWrote ${outputPath}\n`);
      } else {
        process.stdout.write(code);
      }
    },
  )
  .fail((msg, err) => {
    if (err) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else if (msg) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exit(1);
  });

await cli.parse();
