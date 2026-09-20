#!/usr/bin/env bun

import type { LabCheck, LabProofReport } from './proof-result.js';

import { runCatalogPreflightCli } from './catalog/preflight.js';
import { runDidRuntimeProof } from './proofs/did-runtime/did-runtime-proof.js';
import { runDoctor } from './doctor.js';
import { runHistoricalArtifactBuildCli } from './catalog/build.js';
import { runRoutingProof } from './proofs/routing/routing-proof.js';

const usage = `enbox-lab <command> [options]

Commands:
  catalog      Verify pinned historical DWN source or fixture capabilities.
  did-runtime  Run the owned private-Pkarr restart and restoration proof.
  doctor       Inspect prerequisites for the P0 proof harnesses.
  prepare      Materialize and prepare one pinned historical artifact.
  routing      Run the isolated addressing and ownership proof.

Options:
  --json       Print the versioned JSON report.
  -h, --help   Show help.
`;

function printTextReport(report: LabProofReport): void {
  console.log(`${report.proof}: ${report.status}`);
  for (const check of report.checks) {
    printTextCheck(check);
  }
}

function printTextCheck(check: LabCheck): void {
  console.log(`  ${check.status.padEnd(11)} ${check.id}: ${check.summary}`);
  if (check.details !== undefined) {
    console.log(`               ${JSON.stringify(check.details)}`);
  }
}

async function run(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }

  const command = args[0];
  if (command === 'catalog') {
    return runCatalogPreflightCli(args.slice(1));
  }

  if (command === 'did-runtime') {
    const didArgs = args.slice(1);
    if (didArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runDidRuntimeProof();
    if (didArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return report.status === 'pass' ? 0 : 1;
  }

  if (command === 'prepare') {
    return runHistoricalArtifactBuildCli(args.slice(1));
  }

  if (command === 'routing') {
    const routingArgs = args.slice(1);
    if (routingArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runRoutingProof();
    if (routingArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return report.status === 'pass' ? 0 : 1;
  }

  const doctorArgs = args.slice(1);
  const positionals = doctorArgs.filter((arg): boolean => !arg.startsWith('-'));
  const unknownOptions = doctorArgs.filter((arg): boolean => arg.startsWith('-') && arg !== '--json');
  if (unknownOptions.length > 0 || positionals.length !== 0 || command !== 'doctor') {
    console.error(usage);
    return 2;
  }

  const report = await runDoctor();
  if (doctorArgs.includes('--json')) {
    console.log(JSON.stringify(report, undefined, 2));
  } else {
    printTextReport(report);
  }
  return report.status === 'pass' ? 0 : 1;
}

process.exitCode = await run();
