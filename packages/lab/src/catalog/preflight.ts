#!/usr/bin/env bun

import type { CatalogPreflightMode } from './catalog-preflight.js';
import type { LabCheck, LabProofReport } from '../proof-result.js';

import { runCatalogPreflight } from './catalog-preflight.js';
import { getHistoricalDwnArtifact, historicalDwnArtifacts } from './historical-artifacts.js';

const usage = `bun packages/lab/src/catalog/preflight.ts [options]

Verifies the pinned historical DWN catalog without checking out or modifying a candidate.

Options:
  --artifact <id>       Check one artifact (default: both).
  --mode <source|fixture>
                        source verifies immutable Git/lock/version facts.
                        fixture also requires image, launcher, and runtime evidence (default).
  --repository <path>   Git repository containing the candidate commits (default: cwd).
  --json                Print the versioned JSON report.
  -h, --help            Show help.
`;

type Options = {
  artifactId?: string;
  json: boolean;
  mode: CatalogPreflightMode;
  repositoryRoot: string;
};

function parseOptions(args: string[]): Options | undefined {
  const options: Options = {
    json           : false,
    mode           : 'fixture',
    repositoryRoot : process.cwd(),
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--artifact') {
      options.artifactId = args[++index];
      if (options.artifactId === undefined) {
        return undefined;
      }
    } else if (argument === '--mode') {
      const mode = args[++index];
      if (mode !== 'fixture' && mode !== 'source') {
        return undefined;
      }
      options.mode = mode;
    } else if (argument === '--repository') {
      const repositoryRoot = args[++index];
      if (repositoryRoot === undefined) {
        return undefined;
      }
      options.repositoryRoot = repositoryRoot;
    } else {
      return undefined;
    }
  }

  return options;
}

function printCheck(check: LabCheck): void {
  console.log(`  ${check.status.padEnd(11)} ${check.id}: ${check.summary}`);
  if (check.details !== undefined) {
    console.log(`               ${JSON.stringify(check.details)}`);
  }
}

function printReport(report: LabProofReport): void {
  console.log(`${report.proof}: ${report.status}`);
  for (const check of report.checks) {
    printCheck(check);
  }
}

export async function runCatalogPreflightCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }

  const options = parseOptions(args);
  if (options === undefined) {
    console.error(usage);
    return 2;
  }

  const artifact = options.artifactId === undefined ? undefined : getHistoricalDwnArtifact(options.artifactId);
  if (options.artifactId !== undefined && artifact === undefined) {
    console.error(`Unknown artifact '${options.artifactId}'. Expected one of: ${historicalDwnArtifacts.map(({ id }) => id).join(', ')}`);
    return 2;
  }

  const report = await runCatalogPreflight({
    artifacts      : artifact === undefined ? historicalDwnArtifacts : [artifact],
    mode           : options.mode,
    repositoryRoot : options.repositoryRoot,
  });
  if (options.json) {
    console.log(JSON.stringify(report, undefined, 2));
  } else {
    printReport(report);
  }
  return report.status === 'pass' ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runCatalogPreflightCli(process.argv.slice(2));
}
